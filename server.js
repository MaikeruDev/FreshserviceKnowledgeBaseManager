import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, saveConfig, publicConfig } from "./lib/config.js";
import { FreshserviceClient, FreshserviceError, normalizeDomain } from "./lib/freshservice.js";
import { generateArticleTurn, buildInitialUserMessage, buildChangeRequestMessage, testOpenAI, AiError } from "./lib/ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3847);
const HOST = process.env.HOST || "127.0.0.1";

const app = express();
app.use(express.json({ limit: "10mb" }));

// Static frontend + vendored libraries (no CDN needed)
app.use(express.static(path.join(__dirname, "public")));
app.use("/vendor/tinymce", express.static(path.join(__dirname, "node_modules", "tinymce")));
app.use("/vendor/dompurify", express.static(path.join(__dirname, "node_modules", "dompurify", "dist")));

// ---- helpers ---------------------------------------------------------------

function fsClient() {
  const c = getConfig();
  return new FreshserviceClient({ domain: c.freshserviceDomain, apiKey: c.freshserviceApiKey, workspaceId: c.freshserviceWorkspaceId });
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// simple in-memory cache for the full overview
let overviewCache = null;

// ---- config ----------------------------------------------------------------

app.get("/api/config", (req, res) => res.json(publicConfig()));

app.post("/api/config", (req, res) => {
  const patch = { ...req.body };
  if (patch.freshserviceDomain !== undefined) patch.freshserviceDomain = normalizeDomain(patch.freshserviceDomain).replace(/^https:\/\//, "");
  saveConfig(patch);
  overviewCache = null;
  res.json(publicConfig());
});

app.post("/api/config/test", wrap(async (req, res) => {
  const c = getConfig();
  const out = { freshservice: null, openai: null };
  try {
    const client = fsClient();
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
  res.json({ categories: await fsClient().categories() });
}));

app.get("/api/fs/folders", wrap(async (req, res) => {
  if (!req.query.category_id) return res.status(400).json({ error: "category_id fehlt" });
  res.json({ folders: await fsClient().folders(req.query.category_id) });
}));

app.get("/api/fs/articles", wrap(async (req, res) => {
  if (!req.query.folder_id) return res.status(400).json({ error: "folder_id fehlt" });
  res.json({ articles: await fsClient().articles(req.query.folder_id) });
}));

app.get("/api/fs/articles/search", wrap(async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ articles: [] });
  res.json({ articles: await fsClient().search(q) });
}));

app.get("/api/fs/articles/:id", wrap(async (req, res) => {
  res.json({ article: await fsClient().article(req.params.id) });
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
  const article = await fsClient().createArticle(data);
  overviewCache = null;
  res.status(201).json({ article });
}));

app.put("/api/fs/articles/:id", wrap(async (req, res) => {
  const article = await fsClient().updateArticle(req.params.id, pickArticleFields(req.body || {}));
  overviewCache = null;
  res.json({ article });
}));

app.delete("/api/fs/articles/:id", wrap(async (req, res) => {
  await fsClient().deleteArticle(req.params.id);
  overviewCache = null;
  res.json({ ok: true });
}));

app.post("/api/fs/folders", wrap(async (req, res) => {
  const { name, category_id, description, visibility } = req.body || {};
  if (!name || !category_id) return res.status(400).json({ error: "name und category_id sind Pflichtfelder." });
  const folder = await fsClient().createFolder({ name, category_id: Number(category_id), description: description || "", visibility: visibility ?? 1 });
  overviewCache = null;
  res.status(201).json({ folder });
}));

app.post("/api/fs/categories", wrap(async (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: "name ist Pflichtfeld." });
  const category = await fsClient().createCategory({ name, description: description || "" });
  overviewCache = null;
  res.status(201).json({ category });
}));

/** Full tree. ?articles=1 loads every article of every folder (slower). ?refresh=1 bypasses cache. */
app.get("/api/fs/overview", wrap(async (req, res) => {
  const withArticles = req.query.articles === "1";
  const refresh = req.query.refresh === "1";
  if (!refresh && overviewCache && (overviewCache.withArticles || !withArticles)) {
    return res.json(overviewCache);
  }
  const data = await fsClient().overview({ withArticles });
  overviewCache = data;
  res.json(data);
}));

// ---- AI --------------------------------------------------------------------

/**
 * body: { messages: [{role, content}], description?, changeRequest?, language?, folders?, targetFolder?, exampleArticles? }
 * First turn: send `description` (+ optional context), messages = [].
 * Follow-ups: send existing `messages` + `changeRequest`.
 */
app.post("/api/ai/generate", wrap(async (req, res) => {
  const c = getConfig();
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
