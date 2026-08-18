import OpenAI from "openai";

/**
 * System prompt = the user's existing custom GPT ("Freshservice KB HTML converter"), verbatim,
 * plus a small wrapper section that explains the JSON envelope the app needs (title/tags/etc.).
 * The HTML rules apply unchanged to the `description_html` field.
 */
const AGENT_INSTRUCTIONS = `This GPT converts Confluence-style or unstructured technical and procedural content into clean, structured HTML specifically formatted for Freshservice documentation.

It always outputs valid HTML only, without markdown fences or additional explanations.

It translates non-English input into English while preserving company-specific names, server names, file paths, OU/group names, emails, and product names exactly as provided.

Formatting rules it must strictly follow:
- Start with an intro paragraph using: <p id="isPasted">...</p>
- Use section titles as: <p><strong>Title</strong></p>
- Prefer unordered lists using <ul><li>...</li></ul>; never use numbered lists
- Keep formatting minimal and clean (no emojis, icons, or excessive styling)
- Use <p><br></p> for spacing when helpful

For any commands, code, configuration, JSON, file paths, or multi-line terminal content, wrap them exactly in:
<div><pre code-brush="text" data-code-brush="Generic Language" rel="highlighter" contenteditable="false" eventadded="true">...</pre>

    <p>
        <br></p>
</div>

Code must be preserved exactly with no smart quotes or formatting changes.

When input includes structures like "Problem / Solution" or "Step 1/2/3", convert them into clearly labeled sections with bullet points (never numbered lists).

It should infer structure when missing and organize content logically into sections.

Tone is neutral, precise, and optimized for internal IT/service documentation.

The output must still remain valid HTML and follow all formatting rules above.`;

const WRAPPER_INSTRUCTIONS = `--- Integration notes (this GPT is called from an internal Freshservice KB tool via API) ---
The tool needs a few metadata fields next to the HTML, so respond with a single JSON object matching the provided schema:
- description_html: the article body. Apply ALL formatting rules above to this field exactly as if it were your entire output (valid HTML only, no markdown fences, no explanations, no <html>/<body>, no <h1> — the article title is stored separately in Freshservice).
- title: concise, searchable Freshservice article title in the article's language (plain text, no trailing period).
- tags: 3–8 short lowercase tags for Freshservice.
- keywords: 5–15 search terms/synonyms users might type (English and, if the source was German, also the German terms).
- suggested_folder_id: if a list of existing folders is provided, the id of the best matching folder; otherwise null.
- notes_for_reviewer: 1–3 short sentences for the human reviewer: assumptions, placeholders to fill, open questions. Never invent URLs, ticket numbers or contacts — use placeholders like [link] instead.
When the reviewer asks for changes, always return the COMPLETE revised article (not a diff) and keep everything else unchanged.
If the user explicitly requests a different output language, that request overrides the default translation to English.`;

export const SYSTEM_PROMPT = `${AGENT_INSTRUCTIONS}\n\n${WRAPPER_INSTRUCTIONS}`;

export const ARTICLE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Article title (plain text)" },
    description_html: { type: "string", description: "Full article body as Freshservice-formatted HTML" },
    tags: { type: "array", items: { type: "string" } },
    keywords: { type: "array", items: { type: "string" } },
    suggested_folder_id: { type: ["integer", "null"] },
    notes_for_reviewer: { type: "string" },
  },
  required: ["title", "description_html", "tags", "keywords", "suggested_folder_id", "notes_for_reviewer"],
  additionalProperties: false,
};

export class AiError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "AiError";
    Object.assign(this, extra);
  }
}

/** Build the first user turn from the free-text description + optional context. */
export function buildInitialUserMessage({ description, language, folders, targetFolder, exampleArticles }) {
  const parts = [];
  parts.push("Convert the following rough description / notes into a Freshservice knowledge base article.");
  if (language) parts.push(`Requested output language: ${language}.`);
  if (targetFolder) parts.push(`Target folder: "${targetFolder.name}" (category "${targetFolder.category || "?"}", id ${targetFolder.id}).`);
  if (Array.isArray(folders) && folders.length) {
    const list = folders
      .slice(0, 300)
      .map((f) => `- id ${f.id}: ${f.category ? f.category + " / " : ""}${f.name}`)
      .join("\n");
    parts.push(`Existing folders (for suggested_folder_id):\n${list}`);
  }
  if (Array.isArray(exampleArticles) && exampleArticles.length) {
    const list = exampleArticles.slice(0, 20).map((a) => `- ${a.title}`).join("\n");
    parts.push(`Titles of existing articles in that folder (for style/consistency):\n${list}`);
  }
  parts.push(`Source content:\n"""\n${description.trim()}\n"""`);
  return parts.join("\n\n");
}

export function buildChangeRequestMessage(changeRequest) {
  return `Reviewer change request:\n"""\n${String(changeRequest).trim()}\n"""\n\nReturn the complete revised article.`;
}

/** Reasoning-effort parameter is only accepted by reasoning models (gpt-5*, o-series), not by *-chat-latest / gpt-4.x. */
function supportsReasoningEffort(model) {
  const m = String(model || "");
  if (/-chat-latest$/.test(m)) return false;
  return /^(gpt-5|o\d)/.test(m);
}

/**
 * Run one turn of the article conversation.
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.model   e.g. gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-4.1
 * @param {string} p.effort  minimal|low|medium|high (reasoning models only)
 * @param {Array<{role:'user'|'assistant', content:string}>} p.messages  full history incl. the new user turn
 * @returns {Promise<{article: object, assistantText: string, usage: object, model: string}>}
 */
export async function generateArticleTurn({ apiKey, model, effort, messages }) {
  if (!apiKey) throw new AiError("OpenAI-API-Key fehlt (Einstellungen).");
  const client = new OpenAI({ apiKey, timeout: 10 * 60 * 1000, maxRetries: 2 });
  const usedModel = model || "gpt-5.5";

  const params = {
    model: usedModel,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    response_format: {
      type: "json_schema",
      json_schema: { name: "freshservice_kb_article", strict: true, schema: ARTICLE_SCHEMA },
    },
  };
  if (effort && supportsReasoningEffort(usedModel)) params.reasoning_effort = effort;

  let completion;
  try {
    completion = await client.chat.completions.create(params);
  } catch (err) {
    if (err instanceof OpenAI.AuthenticationError) throw new AiError("OpenAI: API-Key ungültig (401).", { status: 401 });
    if (err instanceof OpenAI.PermissionDeniedError) throw new AiError(`OpenAI: Kein Zugriff (403) – ${err.message}`, { status: 403 });
    if (err instanceof OpenAI.NotFoundError) throw new AiError(`OpenAI: Modell "${usedModel}" nicht gefunden (404).`, { status: 404 });
    if (err instanceof OpenAI.RateLimitError) throw new AiError("OpenAI: Rate-Limit/Quota erreicht (429). Bitte kurz warten oder Billing prüfen.", { status: 429 });
    if (err instanceof OpenAI.BadRequestError) throw new AiError(`OpenAI: Ungültige Anfrage – ${err.message}`, { status: 400 });
    if (err instanceof OpenAI.APIConnectionError) throw new AiError("OpenAI: Keine Verbindung zur API.", { status: 502 });
    if (err instanceof OpenAI.APIError) throw new AiError(`OpenAI API-Fehler ${err.status}: ${err.message}`, { status: err.status || 502 });
    throw err;
  }

  const choice = completion.choices?.[0];
  if (!choice) throw new AiError("OpenAI hat keine Antwort geliefert.", { status: 502 });
  if (choice.message?.refusal) throw new AiError(`ChatGPT hat die Anfrage abgelehnt: ${choice.message.refusal}`, { status: 422 });
  if (choice.finish_reason === "length") throw new AiError("Antwort wurde abgeschnitten (Token-Limit). Bitte Beschreibung kürzen oder Artikel aufteilen.", { status: 422 });
  if (choice.finish_reason === "content_filter") throw new AiError("Antwort wurde vom OpenAI-Content-Filter blockiert.", { status: 422 });

  const text = choice.message?.content || "";
  let article;
  try {
    article = JSON.parse(text);
  } catch {
    throw new AiError("ChatGPT hat kein gültiges JSON geliefert.", { status: 502, raw: text.slice(0, 2000) });
  }

  return { article, assistantText: text, usage: completion.usage, model: completion.model };
}

/** Cheap connectivity/key check. */
export async function testOpenAI({ apiKey, model }) {
  const client = new OpenAI({ apiKey, timeout: 60_000 });
  const m = await client.models.retrieve(model || "gpt-5.5");
  return { ok: true, model: m.id, owned_by: m.owned_by };
}
