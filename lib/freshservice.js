/**
 * Minimal Freshservice API v2 client for the Solutions (Knowledge Base) endpoints.
 * Docs: https://api.freshservice.com/v2/#solution-article
 *
 * Auth: HTTP Basic with the API key as username and "X" as password.
 */

export class FreshserviceError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.name = "FreshserviceError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

/** Accepts "acme", "acme.freshservice.com" or "https://acme.freshservice.com/" → "https://acme.freshservice.com" */
export function normalizeDomain(input) {
  let d = String(input || "").trim();
  if (!d) return "";
  const m = d.match(/^(https?):\/\//i);
  const scheme = m ? m[1].toLowerCase() : "https"; // http only useful for local mock/proxy setups
  d = d.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (!d.includes(".") && !d.includes(":")) d = `${d}.freshservice.com`;
  return `${scheme}://${d}`;
}

export class FreshserviceClient {
  constructor({ domain, apiKey, workspaceId }) {
    this.baseUrl = normalizeDomain(domain);
    this.apiKey = apiKey;
    this.workspaceId = workspaceId ? String(workspaceId).trim() : "";
    if (!this.baseUrl) throw new FreshserviceError("Freshservice-Domain fehlt (Einstellungen).");
    if (!this.apiKey) throw new FreshserviceError("Freshservice-API-Key fehlt (Einstellungen).");
  }

  get authHeader() {
    return "Basic " + Buffer.from(`${this.apiKey}:X`).toString("base64");
  }

  async request(method, apiPath, { query, body, retry = 1 } = {}) {
    const url = new URL(`/api/v2${apiPath}`, this.baseUrl);
    const q = { ...(query || {}) };
    if (this.workspaceId && q.workspace_id === undefined) q.workspace_id = this.workspaceId;
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429 && retry > 0) {
      const wait = Math.min(Number(res.headers.get("retry-after") || 5), 60);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.request(method, apiPath, { query, body, retry: retry - 1 });
    }

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      const detail =
        json?.description ||
        json?.message ||
        (Array.isArray(json?.errors) ? json.errors.map((e) => `${e.field ? e.field + ": " : ""}${e.message}`).join("; ") : "") ||
        text?.slice(0, 300) ||
        res.statusText;
      throw new FreshserviceError(`Freshservice ${res.status}: ${detail}`, { status: res.status, body: json, url: url.toString() });
    }
    return { json, headers: res.headers };
  }

  /** Follow pagination (Link header / full pages) and concatenate `key` arrays. */
  async listAll(apiPath, key, query = {}) {
    const perPage = 100;
    const out = [];
    for (let page = 1; page <= 200; page++) {
      const { json, headers } = await this.request("GET", apiPath, { query: { ...query, page, per_page: perPage } });
      const items = (json && json[key]) || [];
      out.push(...items);
      const link = headers.get("link") || "";
      const hasNext = /rel="next"/.test(link) || items.length >= perPage;
      if (!hasNext || items.length === 0) break;
    }
    return out;
  }

  // ---- Solutions ----------------------------------------------------------

  categories() {
    return this.listAll("/solutions/categories", "categories");
  }

  folders(categoryId) {
    return this.listAll("/solutions/folders", "folders", { category_id: categoryId });
  }

  articles(folderId) {
    return this.listAll("/solutions/articles", "articles", { folder_id: folderId });
  }

  async article(id) {
    const { json } = await this.request("GET", `/solutions/articles/${id}`);
    return json.article;
  }

  async search(term) {
    const { json } = await this.request("GET", "/solutions/articles/search", { query: { search_term: term } });
    return json.articles || [];
  }

  async createArticle(data) {
    const { json } = await this.request("POST", "/solutions/articles", { body: data });
    return json.article;
  }

  async updateArticle(id, data) {
    const { json } = await this.request("PUT", `/solutions/articles/${id}`, { body: data });
    return json.article;
  }

  async deleteArticle(id) {
    await this.request("DELETE", `/solutions/articles/${id}`);
    return true;
  }

  async createFolder(data) {
    const { json } = await this.request("POST", "/solutions/folders", { body: data });
    return json.folder;
  }

  async createCategory(data) {
    const { json } = await this.request("POST", "/solutions/categories", { body: data });
    return json.category;
  }

  /** Whole tree: categories → folders → (optionally) articles. */
  async overview({ withArticles = false, onProgress } = {}) {
    const categories = await this.categories();
    const tree = [];
    let folderCount = 0;
    let articleCount = 0;
    for (const cat of categories) {
      const folders = await this.folders(cat.id);
      const folderNodes = [];
      for (const folder of folders) {
        folderCount++;
        let articles = [];
        if (withArticles) {
          articles = await this.articles(folder.id);
          articleCount += articles.length;
          onProgress?.({ folderCount, articleCount, current: folder.name });
        }
        folderNodes.push({ ...folder, articles });
      }
      tree.push({ ...cat, folders: folderNodes });
    }
    return { categories: tree, folderCount, articleCount, loadedAt: new Date().toISOString(), withArticles };
  }
}
