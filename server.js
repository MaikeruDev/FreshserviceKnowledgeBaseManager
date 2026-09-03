import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { credsFromRequest, publicConfig } from "./lib/config.js";
import { FreshserviceClient, FreshserviceError } from "./lib/freshservice.js";
import { generateArticleTurn, buildInitialUserMessage, buildChangeRequestMessage, testOpenAI, AiError } from "./lib/ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;
const PORT = Number(process.env.PORT || 3847);
const HOST = process.env.HOST || "127.0.0.1";

const app = express();
app.use(express.json({ limit: "40mb" })); // article HTML + base64 image uploads

// Static frontend + vendored libraries (no CDN needed).
// App files: always revalidate (ETag → 304) so deployments take effect without hard reloads.
app.use(express.static(path.join(__dirname, "public"), { etag: true, lastModified: true, setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") }));
app.use("/vendor/tinymce", express.static(path.join(__dirname, "node_modules", "tinymce")));
app.use("/vendor/dompurify", express.static(path.join(__dirname, "node_modules", "dompurify", "dist")));

// ---- helpers ---------------------------------------------------------------

/** Freshservice client built from the credentials the browser sent with this request (headers). Nothing is stored server-side. */
function fsClient(req) {
  const c = credsFromRequest(req);
  return new FreshserviceClient({ domain: c.freshserviceDomain, apiKey: c.freshserviceApiKey, workspaceId: c.freshserviceWorkspaceId });
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// short-lived in-memory cache for the full overview (article metadata, no secrets), keyed per account so users never see each other's data
const overviewCache = new Map(); // cacheKey -> overview
const OVERVIEW_TTL_MS = 30 * 60 * 1000;
function cacheKey(req) {
  const c = credsFromRequest(req);
  return crypto.createHash("sha256").update(`${c.freshserviceDomain}|${c.freshserviceWorkspaceId}|${c.freshserviceApiKey}`).digest("hex");
}
function invalidateOverview(req) {
  overviewCache.delete(cacheKey(req));
}

// ---- image uploads (temporary, until the article is saved) ------------------
// Freshservice rejects base64 images in article HTML, so images are held here,
// attached to the article as attachments[] on save and referenced via canonical_url.
// Stored on disk (data/uploads) so they survive server restarts/deploys while an editor is still open.
const UPLOAD_DIR = path.join(__dirname, "data", "uploads");
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const uploads = {
  _meta(id) { return path.join(UPLOAD_DIR, `${id}.json`); },
  _bin(id) { return path.join(UPLOAD_DIR, `${id}.bin`); },
  set(id, { buffer, mime, filename, createdAt }) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(this._bin(id), buffer);
    fs.writeFileSync(this._meta(id), JSON.stringify({ mime, filename, createdAt, size: buffer.length }));
  },
  has(id) { return fs.existsSync(this._meta(id)) && fs.existsSync(this._bin(id)); },
  get(id) {
    try {
      const meta = JSON.parse(fs.readFileSync(this._meta(id), "utf8"));
      return { ...meta, buffer: fs.readFileSync(this._bin(id)) };
    } catch { return undefined; }
  },
  delete(id) {
    for (const p of [this._meta(id), this._bin(id)]) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  },
  purge() {
    try {
      const cutoff = Date.now() - UPLOAD_TTL_MS;
      for (const f of fs.readdirSync(UPLOAD_DIR)) {
        if (!f.endsWith(".json")) continue;
        const id = f.slice(0, -5);
        const meta = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, f), "utf8"));
        if ((meta.createdAt || 0) < cutoff) this.delete(id);
      }
    } catch { /* dir may not exist yet */ }
  },
};
uploads.purge();
setInterval(() => uploads.purge(), 60 * 60 * 1000).unref();

const TEMP_IMG_RE = /(?:https?:\/\/[^/"'\s>]+)?\/api\/uploads\/([0-9a-f-]{36})/g;
// proxy URL as used for display in the app: /api/fs/attachment/<id>?article=<articleId>&orig=<encoded canonical url>
const PROXY_IMG_RE = /(?:https?:\/\/[^/"'\s>]+)?\/api\/fs\/attachment\/(\d+)(?:\?([^"'\s>]*))?/g;

/** Restore the Freshservice URL from a proxy URL (prefers the original canonical_url carried in ?orig=). */
function proxyToCanonical(client, attId, query) {
  if (query) {
    const orig = new URLSearchParams(query.replace(/&amp;/g, "&")).get("orig");
    if (orig && /^https?:\/\/[^/]+\/helpdesk\/attachments\/\d+/.test(orig)) return orig;
  }
  return `${client.baseUrl}/helpdesk/attachments/${attId}`;
}

/**
 * Map uploaded files to the attachments Freshservice returned.
 * Only attachments that did not exist before the save are candidates. Strategy: exact name → (size, content_type)
 * when unique → positional order when counts match. Returns Map(uid → attachment).
 */
function matchAttachments(files, attachments, beforeIds) {
  const mapping = new Map();
  const candidates = (attachments || []).filter((a) => !beforeIds.has(Number(a.id)));
  const used = new Set();
  const take = (f, a) => { mapping.set(f.uid, a); used.add(a.id); };

  // 1) exact name (Freshservice may also lowercase/strip characters → compare normalized too)
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9.]+/g, "");
  for (const f of files) {
    const a = candidates.find((c) => !used.has(c.id) && (c.name === f.uploadName || norm(c.name) === norm(f.uploadName)));
    if (a) take(f, a);
  }
  // 2) unique size + content type
  for (const f of files) {
    if (mapping.has(f.uid)) continue;
    const hits = candidates.filter((c) => !used.has(c.id) && Number(c.file_size ?? c.size) === f.buffer.length && (!c.content_type || !f.mime || c.content_type === f.mime));
    if (hits.length === 1) take(f, hits[0]);
  }
  // 3) positional, only when the remaining counts match exactly
  const restFiles = files.filter((f) => !mapping.has(f.uid));
  const restAtts = candidates.filter((c) => !used.has(c.id));
  if (restFiles.length && restFiles.length === restAtts.length) restFiles.forEach((f, i) => take(f, restAtts[i]));
  return mapping;
}

// ---- author byline (fallback when Freshservice ignores agent_id) ------------
const BYLINE_RE = /\s*<p[^>]*>\s*<em>\s*Author:\s*[^<]*<\/em>\s*<\/p>\s*$/i;
function withByline(html, name) {
  const base = String(html || "").replace(BYLINE_RE, "");
  return `${base}\n<p><em>Author: ${name.replace(/[<>&]/g, "")}</em></p>`;
}

/**
 * Create or update an article.
 * - author: { agent_id, name } → agent_id is attempted natively (undocumented in the Freshservice API; works only if the
 *   instance accepts it). If Freshservice keeps the API-key owner as author and `byline` is true, an "Author: …" line
 *   is appended to the article instead.
 * - images: temporary uploads (/api/uploads/<id>) are sent as attachments[] via multipart and <img src> is rewritten
 *   to the attachment's canonical_url afterwards.
 */
async function saveArticle(client, data, id, { author, byline = true } = {}) {
  // proxy URLs the editor used for display → stable Freshservice URLs
  if (typeof data.description === "string") {
    data.description = data.description.replace(PROXY_IMG_RE, (m, attId, query) => proxyToCanonical(client, attId, query));
  }
  const ids = [...new Set([...(data.description || "").matchAll(TEMP_IMG_RE)].map((m) => m[1]))];
  const files = ids
    .map((uid) => ({ uid, ...(uploads.get(uid) || {}) }))
    .filter((f) => f.buffer)
    .map((f) => ({ ...f, uploadName: `img-${f.uid.slice(0, 8)}-${f.filename}` }));
  const missingUploads = ids.filter((uid) => !uploads.has(uid));

  // attachments that exist before this save (update) → lets us identify the NEW ones by difference afterwards
  let beforeIds = new Set();
  if (id && files.length) {
    try { beforeIds = new Set(((await client.article(id)).attachments || []).map((a) => Number(a.id))); } catch { /* best effort */ }
  }

  const wantAgentId = author?.agent_id ? Number(author.agent_id) : null;
  // Create/update the article WITHOUT agent_id. Freshservice's create validator rejects agent_id as an
  // "invalid_field"; the writable path is a *separate* update on the finished article (this mirrors the
  // Freshdesk Solution-Article API, where agent_id is a documented parameter of "Update a Solution Article").
  const save = async (payload) =>
    files.length ? client.saveArticleWithAttachments(payload, files, id)
      : id ? client.updateArticle(id, payload) : client.createArticle(payload);

  let article = await save(data);
  let agentIdRejected = false;

  // Set the author afterward via a dedicated JSON update (agent_id = "ID of the agent who created the article").
  if (wantAgentId && Number(article.agent_id) !== wantAgentId) {
    try {
      const updated = await client.updateArticle(article.id, { agent_id: wantAgentId });
      if (updated) article = updated;
    } catch (e) {
      if (!(e instanceof FreshserviceError)) throw e;
      agentIdRejected = true; // instance refuses agent_id even on update → byline fallback below
    }
  }

  // native author applied? (only decidable when Freshservice returns agent_id)
  const nativeAuthor = wantAgentId ? Number(article.agent_id) === wantAgentId : null;

  // post-processing of the description: image URLs + byline fallback
  let description = data.description;
  const unmapped = [];
  const replaceTemp = (uid, url) => {
    description = description.replace(new RegExp(`(?:https?:\\/\\/[^/"'\\s>]+)?\\/api\\/uploads\\/${uid}`, "g"), url);
  };
  if (files.length) {
    // the save response sometimes lacks (fresh) attachments → re-read the article to be sure
    let atts = article.attachments;
    if (!Array.isArray(atts) || atts.filter((a) => !beforeIds.has(Number(a.id))).length < files.length) {
      try { atts = (await client.article(article.id)).attachments || atts || []; } catch { atts = atts || []; }
    }
    let mapping = matchAttachments(files, atts, beforeIds);

    // anything still unmatched: upload one file at a time — then the single new attachment is unambiguous
    for (const f of files) {
      if (mapping.has(f.uid)) continue;
      try {
        const known = new Set([...beforeIds, ...atts.map((a) => Number(a.id))]);
        const updated = await client.saveArticleWithAttachments({}, [f], article.id);
        let after = updated.attachments;
        if (!Array.isArray(after)) after = (await client.article(article.id)).attachments || [];
        const fresh = after.filter((a) => !known.has(Number(a.id)));
        const att = fresh.find((a) => a.name === f.uploadName) || (fresh.length === 1 ? fresh[0] : null);
        if (att) { mapping.set(f.uid, att); atts = after; }
      } catch { /* reported as unmapped below */ }
    }

    for (const f of files) {
      const att = mapping.get(f.uid);
      const url = att?.canonical_url || att?.attachment_url;
      if (!url) { unmapped.push(f.filename || f.uploadName); continue; }
      replaceTemp(f.uid, url);
    }
  }
  let bylineUsed = false;
  if (wantAgentId && nativeAuthor === false && byline && author.name) {
    description = withByline(description, author.name);
    bylineUsed = true;
  } else if (wantAgentId && nativeAuthor === true && author.name && BYLINE_RE.test(description || "")) {
    // native author works → a byline naming the same person is redundant; other bylines are left untouched
    const m = description.match(BYLINE_RE);
    if (m && new RegExp(`Author:\\s*${author.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*<`, "i").test(m[0])) {
      description = description.replace(BYLINE_RE, "");
    }
  }
  if (typeof description === "string" && description !== data.description) {
    article = await client.updateArticle(article.id, { description });
  }
  // only drop temp uploads that made it into Freshservice; unmapped ones stay so a re-save can retry
  const unmappedNames = new Set(unmapped);
  for (const f of files) if (!unmappedNames.has(f.filename || f.uploadName)) uploads.delete(f.uid);

  return {
    article,
    images: { attached: files.length - unmapped.length, unmapped, missing: missingUploads },
    author: wantAgentId ? { requested: wantAgentId, native: nativeAuthor, rejected: agentIdRejected, byline: bylineUsed, actual_agent_id: article.agent_id ?? null } : null,
  };
}

// ---- config ----------------------------------------------------------------

/** Only tells the browser whether ENV defaults exist — keys themselves are never sent or stored here. */
app.get("/api/config", (req, res) => res.json({ ...publicConfig(), version: APP_VERSION }));

app.post("/api/config/test", wrap(async (req, res) => {
  const c = credsFromRequest(req);
  const out = { freshservice: null, openai: null };
  try {
    const client = fsClient(req);
    const cats = await client.categories();
    const me = await client.me();
    out.freshservice = {
      ok: true, categories: cats.length, baseUrl: client.baseUrl,
      keyOwner: me ? { id: me.id, name: [me.first_name, me.last_name].filter(Boolean).join(" "), email: me.email || "" } : null,
    };
  } catch (e) {
    out.freshservice = { ok: false, error: e.message };
  }
  if (c.openaiApiKey) {
    try {
      out.openai = await testOpenAI({ apiKey: c.openaiApiKey, model: c.aiModel });
    } catch (e) {
      out.openai = { ok: false, error: e.message };
    }
  } else {
    out.openai = { ok: false, error: "Kein OpenAI-API-Key hinterlegt." };
  }
  res.json(out);
}));

// ---- Freshservice proxy ----------------------------------------------------

app.get("/api/fs/categories", wrap(async (req, res) => {
  res.json({ categories: await fsClient(req).categories() });
}));

app.get("/api/fs/folders", wrap(async (req, res) => {
  if (!req.query.category_id) return res.status(400).json({ error: "category_id fehlt" });
  res.json({ folders: await fsClient(req).folders(req.query.category_id) });
}));

app.get("/api/fs/articles", wrap(async (req, res) => {
  if (!req.query.folder_id) return res.status(400).json({ error: "folder_id fehlt" });
  res.json({ articles: await fsClient(req).articles(req.query.folder_id) });
}));

app.get("/api/fs/articles/search", wrap(async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ articles: [] });
  res.json({ articles: await fsClient(req).search(q) });
}));

app.get("/api/fs/articles/:id", wrap(async (req, res) => {
  res.json({ article: await fsClient(req).article(req.params.id) });
}));

function pickArticleFields(body) {
  const out = {};
  const allowed = ["title", "description", "folder_id", "article_type", "status", "tags", "keywords", "review_date"];
  for (const k of allowed) if (body[k] !== undefined) out[k] = body[k];
  if (out.folder_id !== undefined) out.folder_id = Number(out.folder_id);
  if (out.article_type !== undefined) out.article_type = Number(out.article_type);
  if (out.status !== undefined) out.status = Number(out.status);
  if (Array.isArray(out.tags)) out.tags = out.tags.map((t) => String(t).trim()).filter(Boolean);
  if (Array.isArray(out.keywords)) out.keywords = out.keywords.map((t) => String(t).trim()).filter(Boolean);
  if (out.review_date === "" || out.review_date === null) delete out.review_date;
  return out;
}

app.post("/api/fs/articles", wrap(async (req, res) => {
  const data = pickArticleFields(req.body || {});
  if (!data.title || !data.description || !data.folder_id) {
    return res.status(400).json({ error: "title, description und folder_id sind Pflichtfelder." });
  }
  const result = await saveArticle(fsClient(req), data, undefined, authorOptions(req.body));
  invalidateOverview(req);
  res.status(201).json(result);
}));

app.put("/api/fs/articles/:id", wrap(async (req, res) => {
  const result = await saveArticle(fsClient(req), pickArticleFields(req.body || {}), req.params.id, authorOptions(req.body));
  invalidateOverview(req);
  res.json(result);
}));

/** body.author = { agent_id, name }, body.byline = boolean (default true) */
function authorOptions(body) {
  const a = body?.author;
  const author = a && a.agent_id ? { agent_id: Number(a.agent_id), name: String(a.name || "").trim() } : null;
  return { author, byline: body?.byline !== false };
}

app.get("/api/fs/agents", wrap(async (req, res) => {
  const agents = await fsClient(req).agents();
  res.json({
    agents: agents.map((a) => ({
      id: a.id,
      name: [a.first_name, a.last_name].filter(Boolean).join(" ") || a.email,
      email: a.email,
      job_title: a.job_title || "",
    })),
  });
}));

// ---- images -----------------------------------------------------------------

/** Editor image upload: { filename, mime, data(base64) } → temporary URL used inside the editor until save. */
app.post("/api/uploads", (req, res) => {
  const { filename, mime, data } = req.body || {};
  if (!data || typeof data !== "string") return res.status(400).json({ error: "Keine Bilddaten." });
  if (!/^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i.test(mime || "")) return res.status(400).json({ error: `Nicht unterstützter Bildtyp: ${mime}` });
  const buffer = Buffer.from(data, "base64");
  if (!buffer.length) return res.status(400).json({ error: "Leere Bilddatei." });
  if (buffer.length > MAX_UPLOAD_BYTES) return res.status(413).json({ error: `Bild zu groß (max. ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).` });
  const id = crypto.randomUUID();
  const safeName = String(filename || "image").replace(/[^\w.-]+/g, "_").slice(-80) || "image";
  const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp", "image/svg+xml": ".svg" }[mime.toLowerCase()] || "";
  uploads.set(id, { buffer, mime, filename: /\.[a-z0-9]{2,5}$/i.test(safeName) ? safeName : safeName + ext, createdAt: Date.now() });
  res.status(201).json({ id, url: `/api/uploads/${id}`, size: buffer.length });
});

app.get("/api/uploads/:id", (req, res) => {
  const u = uploads.get(req.params.id);
  if (!u) return res.status(404).send("Upload nicht (mehr) vorhanden.");
  res.setHeader("Content-Type", u.mime);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(u.buffer);
});

/**
 * Proxy for Freshservice attachment images so they render inside the app (browser has no Freshservice session cookies).
 * The helpdesk route (/helpdesk/attachments/<id>) only works with a browser session, NOT with API-key auth — it returns
 * the login page. So we resolve the attachment through the API: GET /solutions/articles/<article> → attachments[] →
 * attachment_url (short-lived signed storage URL) and stream that. ?article=<id> is required for this path;
 * without it we fall back to the helpdesk URL (works only if the instance accepts API-key auth there).
 */
app.get("/api/fs/attachment/:id", wrap(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).send("bad id");
  const client = fsClient(req);
  const attId = Number(req.params.id);
  const articleId = /^\d+$/.test(String(req.query.article || "")) ? Number(req.query.article) : null;

  const sendUpstream = async (upstream) => {
    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    if (!upstream.ok || /text\/html/i.test(ct)) return false; // login page / error → not an image
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "private, max-age=900");
    res.send(Buffer.from(await upstream.arrayBuffer()));
    return true;
  };

  // 1) documented download endpoint: GET /api/v2/attachments/<id> (API-key auth, redirects to storage)
  try {
    if (await sendUpstream(await client.fetchAttachmentApi(attId))) return;
  } catch { /* network error → try next */ }
  // 2) via the article: attachments[].attachment_url (signed storage URL, no auth needed)
  if (articleId) {
    try {
      const article = await client.article(articleId);
      const att = (article.attachments || []).find((a) => Number(a.id) === attId);
      if (att?.attachment_url) {
        if (await sendUpstream(await fetch(att.attachment_url, { redirect: "follow" }))) return;
      }
    } catch (e) {
      if (!(e instanceof FreshserviceError)) throw e; // article not found/no access → try fallback below
    }
  }
  // 3) helpdesk web route (returns the login page on most instances)
  if (await sendUpstream(await client.fetchAttachment(attId))) return;
  res.status(502).send(articleId
    ? `Freshservice-Anhang ${attId} nicht ladbar (nicht an Artikel ${articleId} gefunden oder kein Zugriff).`
    : `Freshservice-Anhang ${attId} nicht ladbar: Helpdesk-Route verlangt Browser-Login; Artikel-ID fehlt für den API-Weg (?article=…).`);
}));

app.delete("/api/fs/articles/:id", wrap(async (req, res) => {
  await fsClient(req).deleteArticle(req.params.id);
  invalidateOverview(req);
  res.json({ ok: true });
}));

app.post("/api/fs/folders", wrap(async (req, res) => {
  const { name, category_id, description, visibility } = req.body || {};
  if (!name || !category_id) return res.status(400).json({ error: "name und category_id sind Pflichtfelder." });
  const folder = await fsClient(req).createFolder({ name, category_id: Number(category_id), description: description || "", visibility: visibility ?? 1 });
  invalidateOverview(req);
  res.status(201).json({ folder });
}));

app.post("/api/fs/categories", wrap(async (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: "name ist Pflichtfeld." });
  const category = await fsClient(req).createCategory({ name, description: description || "" });
  invalidateOverview(req);
  res.status(201).json({ category });
}));

/** Full tree. ?articles=1 loads every article of every folder (slower). ?refresh=1 bypasses cache. */
app.get("/api/fs/overview", wrap(async (req, res) => {
  const withArticles = req.query.articles === "1";
  const refresh = req.query.refresh === "1";
  const key = cacheKey(req);
  const cached = overviewCache.get(key);
  if (!refresh && cached && Date.now() - cached.at < OVERVIEW_TTL_MS && (cached.data.withArticles || !withArticles)) {
    return res.json(cached.data);
  }
  const data = await fsClient(req).overview({ withArticles });
  overviewCache.set(key, { at: Date.now(), data });
  res.json(data);
}));

// ---- AI --------------------------------------------------------------------

/**
 * body: { messages: [{role, content}], description?, changeRequest?, language?, folders?, targetFolder?, exampleArticles? }
 * First turn: send `description` (+ optional context), messages = [].
 * Follow-ups: send existing `messages` + `changeRequest`.
 */
app.post("/api/ai/generate", wrap(async (req, res) => {
  const c = credsFromRequest(req);
  const body = req.body || {};
  const history = Array.isArray(body.messages) ? body.messages.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") : [];

  let userText;
  if (history.length === 0) {
    if (!body.description || !String(body.description).trim()) return res.status(400).json({ error: "Beschreibung fehlt." });
    userText = buildInitialUserMessage({
      description: String(body.description),
      language: body.language,
      folders: body.folders,
      targetFolder: body.targetFolder,
      exampleArticles: body.exampleArticles,
    });
  } else {
    if (!body.changeRequest || !String(body.changeRequest).trim()) return res.status(400).json({ error: "Änderungswunsch fehlt." });
    userText = buildChangeRequestMessage(body.changeRequest);
  }

  const messages = [...history, { role: "user", content: userText }];
  const result = await generateArticleTurn({ apiKey: c.openaiApiKey, model: c.aiModel, effort: c.aiEffort, messages });
  messages.push({ role: "assistant", content: result.assistantText });

  res.json({ article: result.article, messages, usage: result.usage, model: result.model });
}));

// ---- errors ----------------------------------------------------------------

app.use((err, req, res, next) => {
  if (err instanceof FreshserviceError) {
    return res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 502).json({ error: err.message, details: err.body });
  }
  if (err instanceof AiError) {
    return res.status(err.status || 500).json({ error: err.message, raw: err.raw });
  }
  console.error(err);
  res.status(500).json({ error: err.message || "Interner Fehler" });
});

app.listen(PORT, HOST, () => {
  console.log(`Fresh Knowledge Manager läuft auf http://${HOST}:${PORT}`);
});
