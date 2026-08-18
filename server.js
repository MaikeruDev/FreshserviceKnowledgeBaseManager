import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { credsFromRequest, publicConfig } from "./lib/config.js";
import { FreshserviceClient, FreshserviceError } from "./lib/freshservice.js";
import { generateArticleTurn, buildInitialUserMessage, buildChangeRequestMessage, testOpenAI, AiError } from "./lib/ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3847);
const HOST = process.env.HOST || "127.0.0.1";

const app = express();
app.use(express.json({ limit: "40mb" })); // article HTML + base64 image uploads

// Static frontend + vendored libraries (no CDN needed)
app.use(express.static(path.join(__dirname, "public")));
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
const uploads = new Map(); // id -> { buffer, mime, filename, createdAt }
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
setInterval(() => {
  const cutoff = Date.now() - UPLOAD_TTL_MS;
  for (const [id, u] of uploads) if (u.createdAt < cutoff) uploads.delete(id);
}, 60 * 60 * 1000).unref();

const TEMP_IMG_RE = /(?:https?:\/\/[^/"'\s>]+)?\/api\/uploads\/([0-9a-f-]{36})/g;
const PROXY_IMG_RE = /(?:https?:\/\/[^/"'\s>]+)?\/api\/fs\/attachment\/(\d+)/g;

/**
 * Create or update an article. If the description references temporary uploads
 * (/api/uploads/<id>), they are sent as attachments[] via multipart, and the
 * <img src> is rewritten to the attachment's canonical_url afterwards.
 */
async function saveArticle(client, data, id) {
  // proxy URLs the editor used for display → stable Freshservice URLs
  if (typeof data.description === "string") {
    data.description = data.description.replace(PROXY_IMG_RE, (m, attId) => `${client.baseUrl}/helpdesk/attachments/${attId}`);
  }
  const ids = [...new Set([...(data.description || "").matchAll(TEMP_IMG_RE)].map((m) => m[1]))];
  const files = ids
    .map((uid) => ({ uid, ...(uploads.get(uid) || {}) }))
    .filter((f) => f.buffer)
    .map((f) => ({ ...f, uploadName: `img-${f.uid.slice(0, 8)}-${f.filename}` }));
  const missingUploads = ids.filter((uid) => !uploads.has(uid));

  if (!files.length) {
    const article = id ? await client.updateArticle(id, data) : await client.createArticle(data);
    return { article, images: { attached: 0, missing: missingUploads } };
  }

  let article = await client.saveArticleWithAttachments(data, files, id);
  const byName = new Map((article.attachments || []).map((a) => [a.name, a]));
  let description = data.description;
  const unmapped = [];
  for (const f of files) {
    const att = byName.get(f.uploadName);
    const url = att?.canonical_url || att?.attachment_url;
    if (!url) { unmapped.push(f.uploadName); continue; }
    description = description.replace(new RegExp(`(?:https?:\\/\\/[^/"'\\s>]+)?\\/api\\/uploads\\/${f.uid}`, "g"), url);
  }
  if (description !== data.description) {
    article = await client.updateArticle(article.id, { description });
  }
  for (const f of files) uploads.delete(f.uid);
  return { article, images: { attached: files.length - unmapped.length, unmapped, missing: missingUploads } };
}

// ---- config ----------------------------------------------------------------

/** Only tells the browser whether ENV defaults exist — keys themselves are never sent or stored here. */
app.get("/api/config", (req, res) => res.json(publicConfig()));

app.post("/api/config/test", wrap(async (req, res) => {
  const c = credsFromRequest(req);
  const out = { freshservice: null, openai: null };
  try {
    const client = fsClient(req);
    const cats = await client.categories();
    out.freshservice = { ok: true, categories: cats.length, baseUrl: client.baseUrl };
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
  const { article, images } = await saveArticle(fsClient(req), data);
  invalidateOverview(req);
  res.status(201).json({ article, images });
}));

app.put("/api/fs/articles/:id", wrap(async (req, res) => {
  const { article, images } = await saveArticle(fsClient(req), pickArticleFields(req.body || {}), req.params.id);
  invalidateOverview(req);
  res.json({ article, images });
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

/** Proxy for Freshservice attachment images so they render inside the app (browser has no Freshservice session cookies here). */
app.get("/api/fs/attachment/:id", wrap(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).send("bad id");
  const upstream = await fsClient(req).fetchAttachment(req.params.id);
  if (!upstream.ok) return res.status(502).send(`Freshservice-Anhang nicht ladbar (${upstream.status})`);
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(Buffer.from(await upstream.arrayBuffer()));
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
