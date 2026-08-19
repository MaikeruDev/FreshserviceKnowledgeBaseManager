/**
 * Credentials handling.
 *
 * Nothing is persisted on the server. The browser keeps the keys (localStorage) and sends
 * them with every request as headers; this module reads them per request. Environment
 * variables can provide operator-side defaults (e.g. a shared deployment with one service key),
 * but the request headers always take precedence.
 */

const HEADER = {
  freshserviceDomain: "x-fs-domain",
  freshserviceApiKey: "x-fs-key",
  freshserviceWorkspaceId: "x-fs-workspace",
  openaiApiKey: "x-openai-key",
  aiModel: "x-ai-model",
  aiEffort: "x-ai-effort",
};

const ENV = {
  freshserviceDomain: "FRESHSERVICE_DOMAIN",
  freshserviceApiKey: "FRESHSERVICE_API_KEY",
  freshserviceWorkspaceId: "FRESHSERVICE_WORKSPACE_ID",
  openaiApiKey: "OPENAI_API_KEY",
  aiModel: "AI_MODEL",
  aiEffort: "AI_EFFORT",
};

const DEFAULTS = { aiModel: "gpt-5.5", aiEffort: "medium" };

function headerValue(req, name) {
  const raw = req.headers[name];
  if (raw === undefined || raw === "") return "";
  try {
    return decodeURIComponent(String(raw)).trim();
  } catch {
    return String(raw).trim();
  }
}

/**
 * Freshservice creds from the browser cookie `fkm_fs` (set by the app, scoped to /api/fs/attachment so that plain
 * <img> requests — which cannot carry custom headers — can still be authorized). Cookie value: encodeURIComponent(JSON).
 */
function cookieCreds(req) {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const m = String(raw).match(/(?:^|;\s*)fkm_fs=([^;]*)/);
  if (!m) return {};
  try {
    const o = JSON.parse(decodeURIComponent(m[1]));
    return {
      freshserviceDomain: typeof o.d === "string" ? o.d : "",
      freshserviceApiKey: typeof o.k === "string" ? o.k : "",
      freshserviceWorkspaceId: typeof o.w === "string" ? o.w : "",
    };
  } catch {
    return {};
  }
}

/** Effective credentials for this request: header → cookie (Freshservice only) → env → default. */
export function credsFromRequest(req) {
  const out = {};
  const fromCookie = cookieCreds(req);
  for (const key of Object.keys(HEADER)) {
    out[key] = headerValue(req, HEADER[key]) || fromCookie[key] || process.env[ENV[key]] || DEFAULTS[key] || "";
  }
  return out;
}

/** What the browser may know about server-side (ENV) defaults — never the secrets themselves. */
export function publicConfig() {
  return {
    storage: "browser", // keys live in the browser only
    envDefaults: {
      freshserviceDomain: process.env.FRESHSERVICE_DOMAIN || "",
      hasFreshserviceKey: Boolean(process.env.FRESHSERVICE_API_KEY),
      freshserviceWorkspaceId: process.env.FRESHSERVICE_WORKSPACE_ID || "",
      hasOpenaiKey: Boolean(process.env.OPENAI_API_KEY),
      aiModel: process.env.AI_MODEL || "",
      aiEffort: process.env.AI_EFFORT || "",
    },
    defaults: DEFAULTS,
  };
}
