import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

const DEFAULTS = {
  freshserviceDomain: "",
  freshserviceApiKey: "",
  freshserviceWorkspaceId: "",
  openaiApiKey: "",
  aiModel: "gpt-5.5",
  aiEffort: "medium",
};

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** Effective config: file values, overridden by environment variables. */
export function getConfig() {
  const file = readFile();
  return {
    ...DEFAULTS,
    ...file,
    freshserviceDomain: process.env.FRESHSERVICE_DOMAIN || file.freshserviceDomain || "",
    freshserviceApiKey: process.env.FRESHSERVICE_API_KEY || file.freshserviceApiKey || "",
    freshserviceWorkspaceId: process.env.FRESHSERVICE_WORKSPACE_ID || file.freshserviceWorkspaceId || "",
    openaiApiKey: process.env.OPENAI_API_KEY || file.openaiApiKey || "",
  };
}

/** Save partial config. Empty-string secrets keep the previously stored value. */
export function saveConfig(patch) {
  const current = readFile();
  const next = { ...DEFAULTS, ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in DEFAULTS)) continue;
    const isSecret = key.endsWith("ApiKey");
    if (isSecret && (value === undefined || value === null || value === "")) continue;
    next[key] = typeof value === "string" ? value.trim() : value;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/** Config safe to send to the browser (no secrets, only whether they exist). */
export function publicConfig() {
  const c = getConfig();
  return {
    freshserviceDomain: c.freshserviceDomain,
    freshserviceWorkspaceId: c.freshserviceWorkspaceId,
    hasFreshserviceKey: Boolean(c.freshserviceApiKey),
    hasOpenaiKey: Boolean(c.openaiApiKey),
    aiModel: c.aiModel,
    aiEffort: c.aiEffort,
    keySources: {
      freshservice: process.env.FRESHSERVICE_API_KEY ? "env" : c.freshserviceApiKey ? "file" : "none",
      openai: process.env.OPENAI_API_KEY ? "env" : c.openaiApiKey ? "file" : "none",
    },
  };
}
