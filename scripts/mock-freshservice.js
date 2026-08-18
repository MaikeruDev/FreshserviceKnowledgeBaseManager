/**
 * Tiny mock of the Freshservice Solutions API v2 for local testing / demo.
 *   node scripts/mock-freshservice.js            → http://127.0.0.1:3901
 * Then set the domain in the app settings to:  http://127.0.0.1:3901   (any API key)
 */
import express from "express";

const app = express();
app.use(express.json({ limit: "5mb" }));

let nextId = 1000;
const now = () => new Date().toISOString();

const categories = [
  { id: 1, name: "IT-Support", description: "Anleitungen für Mitarbeitende", created_at: now(), updated_at: now() },
  { id: 2, name: "HR & Onboarding", description: "", created_at: now(), updated_at: now() },
];
const folders = [
  { id: 11, category_id: 1, name: "Netzwerk & VPN", description: "VPN, WLAN, Remote", visibility: 1, created_at: now(), updated_at: now() },
  { id: 12, category_id: 1, name: "Microsoft 365", description: "", visibility: 1, created_at: now(), updated_at: now() },
  { id: 21, category_id: 2, name: "Erster Arbeitstag", description: "", visibility: 2, created_at: now(), updated_at: now() },
];
const articles = [
  {
    id: 101, folder_id: 11, category_id: 1, title: "VPN einrichten unter Windows 11", status: 2, article_type: 1,
    description: "<h2>Zweck</h2><p>Diese Anleitung zeigt, wie du den <strong>Cisco AnyConnect</strong> VPN-Client installierst.</p><h2>Schritte</h2><ol><li>Öffne das <strong>Softwarecenter</strong>.</li><li>Installiere <em>AnyConnect</em>.</li><li>Verbinde dich mit <code>vpn.example.com</code>.</li></ol><blockquote>Hinweis: MFA-Code ist 30 Sekunden gültig.</blockquote>",
    description_text: "Diese Anleitung zeigt, wie du den Cisco AnyConnect VPN-Client installierst.",
    tags: ["vpn", "windows", "remote"], keywords: ["anyconnect", "vpn verbindung", "homeoffice"], views: 231, thumbs_up: 12, thumbs_down: 1,
    created_at: "2026-03-02T09:12:00Z", updated_at: "2026-07-14T15:40:00Z", review_date: null, approval_status: null,
  },
  {
    id: 102, folder_id: 11, category_id: 1, title: "WLAN „Corp-Secure“ auf dem iPhone verbinden", status: 1, article_type: 1,
    description: "<p>Kurzanleitung für iOS.</p><ul><li>Einstellungen → WLAN</li><li>Corp-Secure wählen</li></ul>",
    description_text: "Kurzanleitung für iOS.", tags: ["wlan", "ios"], keywords: ["wifi", "iphone"], views: 40, thumbs_up: 2, thumbs_down: 0,
    created_at: "2026-05-11T09:12:00Z", updated_at: "2026-05-12T10:00:00Z",
  },
  {
    id: 103, folder_id: 12, category_id: 1, title: "Outlook: Abwesenheitsnotiz einrichten", status: 2, article_type: 1,
    description: "<h2>So geht's</h2><ol><li>Datei → Automatische Antworten</li><li>Zeitraum wählen</li></ol><table><thead><tr><th>Option</th><th>Bedeutung</th></tr></thead><tbody><tr><td>Innerhalb</td><td>Kollegen</td></tr><tr><td>Außerhalb</td><td>Externe</td></tr></tbody></table>",
    description_text: "Datei → Automatische Antworten", tags: ["outlook", "m365"], keywords: ["ooo", "out of office"], views: 980, thumbs_up: 44, thumbs_down: 3,
    created_at: "2025-11-01T09:12:00Z", updated_at: "2026-06-30T08:00:00Z",
  },
  {
    id: 104, folder_id: 21, category_id: 2, title: "Checkliste erster Arbeitstag", status: 2, article_type: 2,
    description: "<p>Willkommen!</p><ul><li>Badge abholen</li><li>Laptop einrichten</li></ul>",
    description_text: "Willkommen! Badge abholen, Laptop einrichten", tags: ["onboarding"], keywords: [], views: 5, thumbs_up: 0, thumbs_down: 0,
    created_at: "2026-01-01T09:12:00Z", updated_at: "2026-01-01T09:12:00Z",
  },
];

app.use((req, res, next) => {
  if (!req.headers.authorization?.startsWith("Basic ")) return res.status(401).json({ description: "Authentication failed", errors: [] });
  next();
});

const paginate = (req, list) => {
  const page = Number(req.query.page || 1);
  const per = Math.min(Number(req.query.per_page || 30), 100);
  return list.slice((page - 1) * per, page * per);
};

app.get("/api/v2/solutions/categories", (req, res) => res.json({ categories: paginate(req, categories) }));
app.post("/api/v2/solutions/categories", (req, res) => {
  const c = { id: nextId++, name: req.body.name, description: req.body.description || "", created_at: now(), updated_at: now() };
  categories.push(c);
  res.status(201).json({ category: c });
});
app.get("/api/v2/solutions/folders", (req, res) => {
  if (!req.query.category_id) return res.status(400).json({ description: "Validation failed", errors: [{ field: "category_id", message: "It should be a valid Integer" }] });
  res.json({ folders: paginate(req, folders.filter((f) => String(f.category_id) === String(req.query.category_id))) });
});
app.post("/api/v2/solutions/folders", (req, res) => {
  const f = { id: nextId++, ...req.body, created_at: now(), updated_at: now() };
  folders.push(f);
  res.status(201).json({ folder: f });
});
app.get("/api/v2/solutions/articles/search", (req, res) => {
  const q = String(req.query.search_term || "").toLowerCase();
  res.json({ articles: articles.filter((a) => `${a.title} ${a.description_text}`.toLowerCase().includes(q)) });
});
app.get("/api/v2/solutions/articles", (req, res) => {
  if (!req.query.folder_id) return res.status(400).json({ description: "Validation failed", errors: [{ field: "folder_id", message: "It should be a valid Integer" }] });
  res.json({ articles: paginate(req, articles.filter((a) => String(a.folder_id) === String(req.query.folder_id))) });
});
app.get("/api/v2/solutions/articles/:id", (req, res) => {
  const a = articles.find((x) => String(x.id) === req.params.id);
  return a ? res.json({ article: a }) : res.status(404).json({ description: "Not found" });
});
app.post("/api/v2/solutions/articles", (req, res) => {
  const b = req.body;
  if (!b.title || !b.description || !b.folder_id) return res.status(400).json({ description: "Validation failed", errors: [{ field: "title", message: "required" }] });
  const folder = folders.find((f) => f.id === Number(b.folder_id));
  const a = {
    id: nextId++, ...b, category_id: folder?.category_id, description_text: String(b.description).replace(/<[^>]+>/g, " ").trim(),
    views: 0, thumbs_up: 0, thumbs_down: 0, created_at: now(), updated_at: now(),
  };
  articles.push(a);
  res.status(201).json({ article: a });
});
app.put("/api/v2/solutions/articles/:id", (req, res) => {
  const a = articles.find((x) => String(x.id) === req.params.id);
  if (!a) return res.status(404).json({ description: "Not found" });
  Object.assign(a, req.body, { updated_at: now() });
  if (req.body.description) a.description_text = String(req.body.description).replace(/<[^>]+>/g, " ").trim();
  res.json({ article: a });
});
app.delete("/api/v2/solutions/articles/:id", (req, res) => {
  const i = articles.findIndex((x) => String(x.id) === req.params.id);
  if (i < 0) return res.status(404).json({ description: "Not found" });
  articles.splice(i, 1);
  res.status(204).end();
});

const PORT = Number(process.env.MOCK_PORT || 3901);
app.listen(PORT, "127.0.0.1", () => console.log(`Mock Freshservice läuft auf http://127.0.0.1:${PORT}`));
