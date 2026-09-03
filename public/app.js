/* Fresh Knowledge Manager – frontend */
(() => {
  "use strict";

  // ---------------------------------------------------------------- state
  const state = {
    agents: null,              // [{id,name,email,job_title}] from Freshservice (for identity / author picker)
    settings: null,            // browser-only credentials/settings (localStorage)
    config: null,              // effective config: settings + server ENV defaults (flags only)
    categories: [],            // [{id,name,folders:[{id,name,category_id,articles:[]}]}]
    articlesByFolder: new Map(), // folderId -> articles[]
    allLoaded: false,
    selectedFolderId: null,
    selectedArticle: null,
    listMode: "folder",        // folder | search | tag
    listItems: [],
    activeTag: null,
    editor: { mode: "create", articleId: null, tinyReady: false, pendingHtml: null },
    ai: { messages: [], article: null, busy: false, mode: "preview" },
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------------------------------------------------------------- settings (browser-only storage)
  // All keys live ONLY in this browser (localStorage) and are sent per request as headers.
  // The server never persists them.
  const SETTINGS_KEY = "fkm.settings";
  const SETTINGS_FIELDS = [
    "freshserviceDomain", "freshserviceApiKey", "freshserviceWorkspaceId", "openaiApiKey", "aiModel", "aiEffort",
    // identity ("who am I") – used as default article author
    "authorAgentId", "authorName", "authorEmail", "bylineEnabled", // bylineEnabled: "" | "1" (on) | "0" (off)
  ];
  const HEADER_NAMES = {
    freshserviceDomain: "x-fs-domain",
    freshserviceApiKey: "x-fs-key",
    freshserviceWorkspaceId: "x-fs-workspace",
    openaiApiKey: "x-openai-key",
    aiModel: "x-ai-model",
    aiEffort: "x-ai-effort",
  };

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      return Object.fromEntries(SETTINGS_FIELDS.map((k) => [k, typeof s[k] === "string" ? s[k] : ""]));
    } catch {
      return Object.fromEntries(SETTINGS_FIELDS.map((k) => [k, ""]));
    }
  }
  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    state.settings = s;
    syncAttachmentCookie();
  }
  function clearSettings() {
    localStorage.removeItem(SETTINGS_KEY);
    state.settings = loadSettings();
    syncAttachmentCookie();
  }
  function credHeaders() {
    const h = {};
    for (const [k, name] of Object.entries(HEADER_NAMES)) {
      const v = state.settings?.[k];
      if (v) h[name] = encodeURIComponent(v);
    }
    return h;
  }

  // <img src="/api/fs/attachment/…"> requests cannot carry custom headers, so the Freshservice creds are additionally
  // kept in a cookie scoped to exactly that path (browser-only, like localStorage; the server reads it per request and
  // never stores it). SameSite=Strict, Secure on https. Cleared together with the settings.
  const ATTACHMENT_COOKIE_PATH = "/api/fs/attachment";
  function syncAttachmentCookie() {
    const s = state.settings || {};
    const secure = location.protocol === "https:" ? "; Secure" : "";
    const base = `fkm_fs=`;
    const attrs = `; Path=${ATTACHMENT_COOKIE_PATH}; SameSite=Strict${secure}`;
    if (s.freshserviceDomain || s.freshserviceApiKey) {
      const value = encodeURIComponent(JSON.stringify({ d: s.freshserviceDomain || "", k: s.freshserviceApiKey || "", w: s.freshserviceWorkspaceId || "" }));
      document.cookie = `${base}${value}${attrs}; Max-Age=${60 * 60 * 24 * 400}`;
    } else {
      document.cookie = `${base}${attrs}; Max-Age=0`;
    }
  }
  /** Earlier versions used a service worker for the same purpose — remove it so it cannot interfere. */
  async function unregisterLegacyServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- utils
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json", ...credHeaders(), ...(opts.headers || {}) },
      ...opts,
      body: opts.body !== undefined && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
    });
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) {
      const msg = data?.error || `${res.status} ${res.statusText}`;
      const err = new Error(msg);
      err.status = res.status;
      err.details = data?.details;
      throw err;
    }
    return data;
  }

  let toastTimer;
  function toast(msg, kind = "") {
    const el = $("#toast");
    el.textContent = msg;
    el.className = `toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), kind === "err" ? 12000 : 4500);
  }

  function setStatus(el, msg, kind = "info") {
    if (typeof el === "string") el = $(el);
    el.innerHTML = msg ? `<div class="msg msg-${kind}">${msg}</div>` : "";
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function sanitize(html) {
    // ADD_ATTR keeps the Freshservice code-block attributes (<pre code-brush=… rel="highlighter">) visible in the preview
    return window.DOMPurify
      ? DOMPurify.sanitize(html || "", { USE_PROFILES: { html: true }, ADD_ATTR: ["target", "code-brush", "data-code-brush", "rel", "eventadded", "contenteditable"] })
      : esc(html || "");
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
  }

  const STATUS = { 1: ["Entwurf", "badge-draft"], 2: ["Veröffentlicht", "badge-pub"] };
  const TYPE = { 1: "Permanent", 2: "Workaround" };

  function folderById(id) {
    for (const c of state.categories) for (const f of c.folders) if (String(f.id) === String(id)) return { ...f, category: c };
    return null;
  }

  /** Same normalization as the server: "acme" → https://acme.freshservice.com; full URLs are kept. */
  function fsBaseUrl() {
    let d = String(state.config?.freshserviceDomain || "").trim();
    if (!d) return "";
    const m = d.match(/^(https?):\/\//i);
    const scheme = m ? m[1].toLowerCase() : "https";
    d = d.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    if (!d.includes(".") && !d.includes(":")) d = `${d}.freshservice.com`;
    return `${scheme}://${d}`;
  }

  /**
   * Freshservice attachment images (…/helpdesk/attachments/<id>, any host incl. custom portal domains) need a browser
   * session; for display in the app they are routed through the local proxy, which resolves them via the API using the
   * article id. The original URL travels along in ?orig= so saving restores it exactly.
   */
  function displayHtml(html, articleId) {
    if (!html) return "";
    return html.replace(/https?:\/\/[^/"'\s>]+\/helpdesk\/attachments\/(\d+)(?!\d)/g, (url, attId) => {
      const q = new URLSearchParams();
      if (articleId) q.set("article", String(articleId));
      q.set("orig", url);
      return `/api/fs/attachment/${attId}?${q.toString()}`;
    });
  }

  function splitList(str) {
    return String(str || "").split(",").map((s) => s.trim()).filter(Boolean);
  }

  // ---------------------------------------------------------------- navigation
  function showView(name) {
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    if (name === "editor") ensureTinyMce();
  }

  $$(".nav-btn").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.view === "editor") openEditor({ mode: "create" });
      else showView(b.dataset.view);
    })
  );

  // ---------------------------------------------------------------- config / settings
  /**
   * Effective config = browser settings, falling back to server ENV defaults (the server only tells us
   * whether such defaults exist; it never sends key values).
   */
  async function loadConfig() {
    state.settings = loadSettings();
    let server = { envDefaults: {}, defaults: { aiModel: "gpt-5.5", aiEffort: "medium" } };
    try { server = await api("/api/config"); } catch (e) { toast("Server nicht erreichbar: " + e.message, "err"); }
    if (server.version) $("#app-version").textContent = "v" + server.version;
    const env = server.envDefaults || {};
    const s = state.settings;
    state.config = {
      freshserviceDomain: s.freshserviceDomain || env.freshserviceDomain || "",
      freshserviceWorkspaceId: s.freshserviceWorkspaceId || env.freshserviceWorkspaceId || "",
      hasFreshserviceKey: Boolean(s.freshserviceApiKey) || Boolean(env.hasFreshserviceKey),
      hasOpenaiKey: Boolean(s.openaiApiKey) || Boolean(env.hasOpenaiKey),
      aiModel: s.aiModel || env.aiModel || server.defaults?.aiModel || "gpt-5.5",
      aiEffort: s.aiEffort || env.aiEffort || server.defaults?.aiEffort || "medium",
      keySources: {
        freshservice: s.freshserviceApiKey ? "browser" : env.hasFreshserviceKey ? "env" : "none",
        openai: s.openaiApiKey ? "browser" : env.hasOpenaiKey ? "env" : "none",
      },
    };

    const chip = $("#conn-chip");
    if (state.config.freshserviceDomain && state.config.hasFreshserviceKey) {
      chip.textContent = fsBaseUrl().replace(/^https?:\/\//, "");
      chip.className = "chip chip-ok";
    } else {
      chip.textContent = "nicht konfiguriert";
      chip.className = "chip chip-warn";
    }
    // settings form: values come straight from this browser's storage
    $("#cfg-domain").value = s.freshserviceDomain || (env.freshserviceDomain ? "" : "");
    $("#cfg-domain").placeholder = env.freshserviceDomain ? `Server-Standard: ${env.freshserviceDomain}` : "meinefirma  oder  meinefirma.freshservice.com";
    $("#cfg-fs-key").value = s.freshserviceApiKey || "";
    $("#cfg-workspace").value = s.freshserviceWorkspaceId || "";
    $("#cfg-ai-key").value = s.openaiApiKey || "";
    $("#cfg-model").value = s.aiModel || state.config.aiModel;
    $("#cfg-effort").value = s.aiEffort || state.config.aiEffort;
    const src = (which) => ({ browser: "(in diesem Browser gespeichert)", env: "(Server-Standard aus ENV aktiv – kann hier überschrieben werden)", none: "(nicht gesetzt)" }[state.config.keySources[which]]);
    $("#cfg-fs-hint").textContent = src("freshservice");
    $("#cfg-ai-hint").textContent = src("openai");
    $("#cfg-fs-key").placeholder = env.hasFreshserviceKey ? "leer = Server-Standard verwenden" : "API-Key aus Freshservice";
    $("#cfg-ai-key").placeholder = env.hasOpenaiKey ? "leer = Server-Standard verwenden" : "sk-…";
    updateIdentityRow();
  }

  function openModal(id) { $(`#${id}`).classList.remove("hidden"); }
  function closeModal(id) { $(`#${id}`).classList.add("hidden"); }
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => closeModal(b.dataset.close)));
  $$(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.classList.add("hidden"); }));

  $("#btn-settings").addEventListener("click", () => { setStatus("#cfg-test-result", ""); openModal("modal-settings"); });

  // ---------------------------------------------------------------- identity / author
  async function loadAgents(force = false) {
    if (state.agents && !force) return state.agents;
    const data = await api("/api/fs/agents");
    state.agents = (data.agents || []).sort((a, b) => a.name.localeCompare(b.name, "de"));
    return state.agents;
  }
  function agentById(id) {
    return (state.agents || []).find((a) => String(a.id) === String(id)) || null;
  }
  function agentLabel(id) {
    const a = agentById(id);
    return a ? a.name : id ? `Agent #${id}` : "";
  }
  /** Default author = the identity chosen in setup (null if not set). */
  function currentAuthor() {
    const s = state.settings || {};
    return s.authorAgentId ? { agent_id: Number(s.authorAgentId), name: s.authorName || agentLabel(s.authorAgentId) } : null;
  }
  function bylineEnabled() {
    return (state.settings?.bylineEnabled || "1") !== "0";
  }
  function authorPayload(agentId) {
    const id = agentId !== undefined ? agentId : state.settings?.authorAgentId;
    if (!id) return { author: null, byline: bylineEnabled() };
    const a = agentById(id);
    return { author: { agent_id: Number(id), name: a?.name || (String(id) === String(state.settings?.authorAgentId) ? state.settings.authorName : `Agent #${id}`) }, byline: bylineEnabled() };
  }
  function fillAuthorSelect(select, selectedId, { allowNone = true } = {}) {
    const opts = [];
    if (allowNone) opts.push('<option value="">– API-Benutzer (Standard von Freshservice) –</option>');
    for (const a of state.agents || []) {
      const me = String(a.id) === String(state.settings?.authorAgentId) ? " (ich)" : "";
      opts.push(`<option value="${a.id}">${esc(a.name)}${me}${a.email ? ` – ${esc(a.email)}` : ""}</option>`);
    }
    select.innerHTML = opts.join("");
    if (selectedId !== undefined && selectedId !== null && selectedId !== "") select.value = String(selectedId);
    if (select.value !== String(selectedId ?? "") && selectedId) {
      // author not in agent list (deactivated agent) → keep it selectable
      select.insertAdjacentHTML("beforeend", `<option value="${esc(selectedId)}">Agent #${esc(selectedId)} (nicht in Liste)</option>`);
      select.value = String(selectedId);
    }
  }

  function renderIdentityList(filter = "") {
    const q = filter.trim().toLowerCase();
    const sel = $("#identity-select");
    const items = (state.agents || []).filter((a) => !q || `${a.name} ${a.email}`.toLowerCase().includes(q));
    sel.innerHTML = items.slice(0, 300).map((a) => `<option value="${a.id}">${esc(a.name)}${a.email ? ` – ${esc(a.email)}` : ""}</option>`).join("");
    if (state.settings?.authorAgentId && items.some((a) => String(a.id) === String(state.settings.authorAgentId))) sel.value = String(state.settings.authorAgentId);
    else if (items.length === 1) sel.value = String(items[0].id);
    if (!items.length) sel.innerHTML = '<option disabled>Keine Treffer</option>';
  }

  /** @param {"setup"|"update"|"change"} reason */
  async function openIdentityModal(reason = "change") {
    $("#identity-title").textContent = reason === "change" ? "Autor / Identität ändern" : "Wer bist du?";
    $("#identity-update-note").classList.toggle("hidden", reason !== "update");
    $("#identity-byline").checked = bylineEnabled();
    $("#identity-search").value = "";
    setStatus("#identity-status", '<span class="spinner"></span>Lade Agentenliste aus Freshservice…', "info");
    openModal("modal-identity");
    try {
      await loadAgents();
      setStatus("#identity-status", "");
      renderIdentityList();
    } catch (e) {
      setStatus("#identity-status", `Agentenliste konnte nicht geladen werden: ${esc(e.message)}<br><small>Der API-Key braucht Leserechte auf Agenten. Du kannst trotzdem später fortfahren.</small>`, "err");
    }
  }
  $("#identity-search").addEventListener("input", (e) => renderIdentityList(e.target.value));
  $("#identity-select").addEventListener("dblclick", () => $("#btn-identity-save").click());
  $("#btn-identity-later").addEventListener("click", () => closeModal("modal-identity"));
  $("#btn-identity-save").addEventListener("click", () => {
    const id = $("#identity-select").value;
    const a = agentById(id);
    if (!a) return setStatus("#identity-status", "Bitte einen Agenten auswählen.", "err");
    saveSettings({ ...state.settings, authorAgentId: String(a.id), authorName: a.name, authorEmail: a.email || "", bylineEnabled: $("#identity-byline").checked ? "1" : "0" });
    closeModal("modal-identity");
    updateIdentityRow();
    toast(`Du bist jetzt „${a.name}“ – wird als Autor vorbelegt.`, "ok");
  });
  $("#btn-cfg-identity").addEventListener("click", () => {
    if (!state.config?.hasFreshserviceKey) return setStatus("#cfg-test-result", "Bitte zuerst Freshservice-Zugang speichern.", "err");
    openIdentityModal("change");
  });
  function updateIdentityRow() {
    const s = state.settings || {};
    $("#cfg-identity-name").textContent = s.authorAgentId ? `${s.authorName || "Agent #" + s.authorAgentId}${s.authorEmail ? ` (${s.authorEmail})` : ""}` : "– noch nicht festgelegt –";
  }

  /** Ask for identity once the Freshservice connection works and no identity is stored yet. */
  function maybeAskIdentity(hadSettingsBefore) {
    if (!state.config?.hasFreshserviceKey || !state.categories.length) return;
    if (state.settings?.authorAgentId) return;
    if (!$("#modal-identity").classList.contains("hidden")) return;
    openIdentityModal(hadSettingsBefore ? "update" : "setup");
  }

  function authorResultToast(base, r) {
    const a = r?.author;
    if (!a) return base;
    if (a.native === true) return `${base} – Autor: ${agentLabel(a.requested)} (nativ gesetzt)`;
    if (a.byline) return `${base} – Freshservice behält den API-Benutzer als Autor; Zeile „Author: ${agentLabel(a.requested)}“ ergänzt`;
    return `${base} – Hinweis: Freshservice hat den Autor nicht übernommen (API-Benutzer bleibt Autor)`;
  }

  function settingsFromForm() {
    return {
      ...(state.settings || {}), // keep identity fields etc.
      freshserviceDomain: $("#cfg-domain").value.trim(),
      freshserviceApiKey: $("#cfg-fs-key").value.trim(),
      freshserviceWorkspaceId: $("#cfg-workspace").value.trim(),
      openaiApiKey: $("#cfg-ai-key").value.trim(),
      aiModel: $("#cfg-model").value.trim(),
      aiEffort: $("#cfg-effort").value,
    };
  }

  $("#btn-cfg-save").addEventListener("click", async () => {
    try {
      const before = settingsFromForm();
      const credsChanged = before.freshserviceDomain !== state.settings?.freshserviceDomain || before.freshserviceApiKey !== state.settings?.freshserviceApiKey;
      saveSettings(before); // localStorage only — never sent to the server for storage
      if (credsChanged) state.agents = null; // different account → reload agent list
      await loadConfig();
      toast("Einstellungen in diesem Browser gespeichert", "ok");
      closeModal("modal-settings");
      await loadTree(true);
      maybeAskIdentity(false); // first successful connection → "Wer bist du?"
    } catch (e) {
      setStatus("#cfg-test-result", esc(e.message), "err");
    }
  });

  $("#btn-cfg-clear").addEventListener("click", async () => {
    if (!confirm("Alle gespeicherten Keys und Einstellungen aus diesem Browser löschen?")) return;
    clearSettings();
    await loadConfig();
    setStatus("#cfg-test-result", "Alle Keys wurden aus diesem Browser entfernt.", "ok");
    $("#tree").innerHTML = '<div class="muted small pad">Bitte zuerst Freshservice in den Einstellungen konfigurieren.</div>';
  });

  $("#btn-cfg-test").addEventListener("click", async () => {
    setStatus("#cfg-test-result", '<span class="spinner"></span>Teste mit den aktuell eingetragenen Werten…', "info");
    try {
      // test with the form values (not yet saved) — sent as headers for this one request only
      const form = settingsFromForm();
      const headers = {};
      for (const [k, name] of Object.entries(HEADER_NAMES)) if (form[k]) headers[name] = encodeURIComponent(form[k]);
      const r = await api("/api/config/test", { method: "POST", headers });
      const parts = [];
      parts.push(r.freshservice?.ok
        ? `<div class="msg msg-ok">Freshservice OK – ${r.freshservice.categories} Kategorien unter ${esc(r.freshservice.baseUrl)}</div>`
        : `<div class="msg msg-err">Freshservice: ${esc(r.freshservice?.error)}</div>`);
      const owner = r.freshservice?.keyOwner;
      if (owner) {
        const mismatch = state.settings?.authorAgentId && Number(state.settings.authorAgentId) !== Number(owner.id);
        parts.push(mismatch
          ? `<div class="msg msg-err">API-Key gehört zu <b>${esc(owner.name)}</b> – Freshservice trägt IMMER den Key-Besitzer als Autor ein. Du bist als „${esc(state.settings.authorName || "?")}" angemeldet: nutze deinen persönlichen API-Key (Freshservice → Profil), damit du nativ als Autor erscheinst.</div>`
          : `<div class="msg msg-ok">API-Key gehört zu ${esc(owner.name)} – neue Artikel bekommen diesen Autor.</div>`);
      }
      parts.push(r.openai?.ok
        ? `<div class="msg msg-ok">OpenAI OK – Modell ${esc(r.openai.model)}</div>`
        : `<div class="msg msg-err">OpenAI: ${esc(r.openai?.error)}</div>`);
      $("#cfg-test-result").innerHTML = parts.join("");
    } catch (e) {
      setStatus("#cfg-test-result", esc(e.message), "err");
    }
  });

  $("#btn-cfg-author-probe").addEventListener("click", async () => {
    const agentId = state.settings?.authorAgentId;
    if (!agentId) { setStatus("#cfg-test-result", 'Bitte zuerst oben unter „Ich bin" einen Autor festlegen.', "err"); return; }
    setStatus("#cfg-test-result", '<span class="spinner"></span>Autor-Diagnose läuft (Test-Entwurf wird angelegt und wieder gelöscht)…', "info");
    try {
      const r = await api("/api/fs/author-probe", { method: "POST", body: { agentId: Number(agentId) } });
      const head = r.verdict === "AUTHOR_SETTABLE"
        ? `<div class="msg msg-ok"><b>Autor lässt sich per API setzen ✓</b> — der Fix greift auf dieser Instanz.</div>`
        : `<div class="msg msg-err"><b>Autor lässt sich per API NICHT setzen ✗</b> — Freshservice behält den API-Key-Besitzer (Agent #${esc(r.ownerAgentId)}) als Autor.</div>`;
      const rows = (r.steps || []).map((s) => {
        const state = s.applied === true ? "✓ GESETZT" : !s.ok ? `✗ Fehler${s.status ? " " + s.status : ""}` : s.status ? `HTTP ${s.status}` : (s.applied === false ? "· keine Änderung" : "· ok");
        const bits = [];
        if (s.error) bits.push(esc(s.error));
        if (s.rejected) bits.push("code=" + esc(s.rejected));
        if (s.isLoginPage) bits.push("Login-Seite (Session nötig)");
        if (s.internalAgentIdAfter !== undefined) bits.push("internal agent_id=" + esc(s.internalAgentIdAfter));
        if (s.agentIdField !== undefined) bits.push("agent_id-Feld: " + esc(s.agentIdField));
        return `<div class="small" style="font-family:monospace">${esc(s.label)}: ${state}${bits.length ? " – " + bits.join(", ") : ""}</div>`;
      }).join("");
      $("#cfg-test-result").innerHTML = head + `<details style="margin-top:6px"><summary class="small muted">Details (${(r.steps || []).length} Schritte) – zum Kopieren</summary><div style="margin-top:4px">${rows}</div><pre class="small" style="white-space:pre-wrap;margin-top:6px">${esc(JSON.stringify(r, null, 2))}</pre></details>`;
    } catch (e) {
      setStatus("#cfg-test-result", "Diagnose fehlgeschlagen: " + esc(e.message), "err");
    }
  });

  // ---------------------------------------------------------------- tree / folders
  async function loadTree(force = false) {
    if (!state.config?.hasFreshserviceKey || !state.config?.freshserviceDomain) {
      $("#tree").innerHTML = '<div class="muted small pad">Bitte zuerst Freshservice in den Einstellungen konfigurieren.</div>';
      return;
    }
    $("#load-status").innerHTML = '<span class="spinner"></span>Lade Struktur…';
    try {
      const data = await api(`/api/fs/overview${force ? "?refresh=1" : ""}`);
      state.categories = data.categories.map((c) => ({ ...c, folders: (c.folders || []).map((f) => ({ ...f, articles: undefined })) }));
      if (data.withArticles) {
        state.articlesByFolder.clear();
        for (const c of data.categories) for (const f of c.folders) state.articlesByFolder.set(f.id, f.articles || []);
        state.allLoaded = true;
        buildTagCloud();
      }
      renderTree();
      fillFolderSelects();
      $("#load-status").textContent = `${state.categories.length} Kategorien, ${data.folderCount} Ordner${state.allLoaded ? `, ${countLoadedArticles()} Artikel` : ""}`;
    } catch (e) {
      $("#load-status").innerHTML = `<span class="msg-err" style="padding:2px 6px;border-radius:4px">${esc(e.message)}</span>`;
      toast(e.message, "err");
    }
  }

  function countLoadedArticles() {
    let n = 0;
    for (const arr of state.articlesByFolder.values()) n += arr.length;
    return n;
  }

  function renderTree() {
    const tree = $("#tree");
    if (!state.categories.length) {
      tree.innerHTML = '<div class="muted small pad">Keine Kategorien gefunden.</div>';
      return;
    }
    tree.innerHTML = state.categories.map((c) => `
      <div class="tree-cat" data-cat="${c.id}">
        <div class="tree-cat-head"><span class="caret">▼</span><span>${esc(c.name)}</span><span class="muted small" style="margin-left:auto">${c.folders.length}</span></div>
        <div class="tree-folders">
          ${c.folders.map((f) => {
            const arts = state.articlesByFolder.get(f.id);
            return `<div class="tree-folder ${String(f.id) === String(state.selectedFolderId) ? "active" : ""}" data-folder="${f.id}" title="${esc(f.description || "")}">
              <span>📁</span><span class="name">${esc(f.name)}</span>${arts ? `<span class="cnt">${arts.length}</span>` : ""}
            </div>`;
          }).join("") || '<div class="muted small pad">keine Ordner</div>'}
        </div>
      </div>`).join("");

    $$(".tree-cat-head", tree).forEach((h) => h.addEventListener("click", () => h.parentElement.classList.toggle("collapsed")));
    $$(".tree-folder", tree).forEach((el) => el.addEventListener("click", () => selectFolder(el.dataset.folder)));
  }

  function fillFolderSelects() {
    const optionsHtml = (withEmpty) =>
      (withEmpty ? '<option value="">– KI schlägt vor –</option>' : "") +
      state.categories.map((c) => `<optgroup label="${esc(c.name)}">${c.folders.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join("")}</optgroup>`).join("");
    $("#ai-folder").innerHTML = optionsHtml(true);
    $("#ai-insert-folder").innerHTML = optionsHtml(false);
    $("#ed-category").innerHTML = state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    $("#nf-category").innerHTML = $("#ed-category").innerHTML;
    fillEditorFolders();
  }

  function fillEditorFolders(selectedFolderId) {
    const catId = $("#ed-category").value;
    const cat = state.categories.find((c) => String(c.id) === String(catId));
    $("#ed-folder").innerHTML = (cat?.folders || []).map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join("");
    if (selectedFolderId) $("#ed-folder").value = String(selectedFolderId);
  }
  $("#ed-category").addEventListener("change", () => fillEditorFolders());

  $("#btn-refresh-tree").addEventListener("click", () => loadTree(true));

  $("#btn-load-all").addEventListener("click", async () => {
    const btn = $("#btn-load-all");
    btn.disabled = true;
    $("#load-status").innerHTML = '<span class="spinner"></span>Lade alle Artikel (kann bei vielen Ordnern dauern)…';
    try {
      const data = await api("/api/fs/overview?articles=1&refresh=1");
      state.categories = data.categories.map((c) => ({ ...c, folders: (c.folders || []).map((f) => ({ ...f, articles: undefined })) }));
      state.articlesByFolder.clear();
      for (const c of data.categories) for (const f of c.folders) state.articlesByFolder.set(f.id, f.articles || []);
      state.allLoaded = true;
      renderTree();
      fillFolderSelects();
      buildTagCloud();
      $("#load-status").textContent = `${state.categories.length} Kategorien, ${data.folderCount} Ordner, ${data.articleCount} Artikel geladen`;
      toast(`${data.articleCount} Artikel geladen`, "ok");
      if (state.selectedFolderId) selectFolder(state.selectedFolderId);
    } catch (e) {
      $("#load-status").textContent = "";
      toast(e.message, "err");
    } finally {
      btn.disabled = false;
    }
  });

  // new folder
  $("#btn-new-folder").addEventListener("click", () => {
    if (!state.categories.length) return toast("Erst Struktur laden.", "err");
    setStatus("#nf-status", "");
    $("#nf-name").value = "";
    $("#nf-desc").value = "";
    openModal("modal-folder");
  });
  $("#btn-nf-save").addEventListener("click", async () => {
    try {
      setStatus("#nf-status", '<span class="spinner"></span>Lege an…', "info");
      const r = await api("/api/fs/folders", {
        method: "POST",
        body: { name: $("#nf-name").value, category_id: $("#nf-category").value, description: $("#nf-desc").value, visibility: Number($("#nf-visibility").value) },
      });
      toast(`Ordner „${r.folder?.name || $("#nf-name").value}“ angelegt`, "ok");
      closeModal("modal-folder");
      await loadTree(true);
    } catch (e) {
      setStatus("#nf-status", esc(e.message), "err");
    }
  });

  // ---------------------------------------------------------------- articles list
  async function loadFolderArticles(folderId, force = false) {
    const key = Number(folderId);
    if (!force && state.articlesByFolder.has(key)) return state.articlesByFolder.get(key);
    const data = await api(`/api/fs/articles?folder_id=${encodeURIComponent(folderId)}`);
    state.articlesByFolder.set(key, data.articles);
    return data.articles;
  }

  async function selectFolder(folderId) {
    state.selectedFolderId = folderId;
    state.activeTag = null;
    state.listMode = "folder";
    $$(".tree-folder").forEach((el) => el.classList.toggle("active", el.dataset.folder === String(folderId)));
    $$(".tag-pill.active").forEach((p) => p.classList.remove("active"));
    const f = folderById(folderId);
    $("#list-title").innerHTML = `${esc(f?.category?.name || "")} <span class="muted">/</span> ${esc(f?.name || "Ordner")}`;
    showList();
    $("#article-list").innerHTML = '<div class="empty"><span class="spinner"></span>Lade Artikel…</div>';
    try {
      const arts = await loadFolderArticles(folderId);
      state.listItems = arts;
      renderList();
      // update count in tree
      const node = $(`.tree-folder[data-folder="${folderId}"]`);
      if (node) {
        let cnt = node.querySelector(".cnt");
        if (!cnt) { cnt = document.createElement("span"); cnt.className = "cnt"; node.appendChild(cnt); }
        cnt.textContent = arts.length;
      }
    } catch (e) {
      $("#article-list").innerHTML = `<div class="empty"><div class="msg msg-err">${esc(e.message)}</div></div>`;
    }
  }

  function renderList() {
    const statusFilter = $("#list-status-filter").value;
    const sort = $("#list-sort").value;
    let items = [...state.listItems];
    if (statusFilter) items = items.filter((a) => String(a.status) === statusFilter);
    items.sort((a, b) => {
      if (sort === "title") return String(a.title).localeCompare(String(b.title), "de");
      if (sort === "views") return (b.views || 0) - (a.views || 0);
      return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
    });
    const list = $("#article-list");
    if (!items.length) {
      list.innerHTML = '<div class="empty">Keine Artikel.</div>';
      return;
    }
    list.innerHTML = items.map((a) => {
      const [sLabel, sCls] = STATUS[a.status] || ["?", "badge-type"];
      const folder = folderById(a.folder_id);
      const snippet = (a.description_text || stripHtml(a.description || "")).slice(0, 220);
      return `<div class="article-card" data-id="${a.id}">
        <div class="title">${esc(a.title)}</div>
        <div class="snippet">${esc(snippet)}</div>
        <div class="meta">
          <span class="badge ${sCls}">${sLabel}</span>
          <span class="badge badge-type">${TYPE[a.article_type] || "–"}</span>
          ${state.listMode !== "folder" && folder ? `<span>📁 ${esc(folder.category?.name)} / ${esc(folder.name)}</span>` : ""}
          <span>Geändert: ${fmtDate(a.updated_at)}</span>
          ${a.views != null ? `<span>👁 ${a.views}</span>` : ""}
          ${(a.tags || []).length ? `<span>🏷 ${a.tags.map(esc).join(", ")}</span>` : ""}
        </div>
      </div>`;
    }).join("");
    $$(".article-card", list).forEach((el) => el.addEventListener("click", () => openArticle(el.dataset.id)));
  }
  $("#list-status-filter").addEventListener("change", renderList);
  $("#list-sort").addEventListener("change", renderList);

  function stripHtml(html) {
    const d = document.createElement("div");
    d.innerHTML = sanitize(html);
    return d.textContent || "";
  }

  function showList() {
    $("#list-panel").classList.remove("hidden");
    $("#detail-panel").classList.add("hidden");
  }

  // ---------------------------------------------------------------- search
  $("#search-input").addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const q = e.target.value.trim();
    if (!q) return;
    state.listMode = "search";
    state.activeTag = null;
    $$(".tree-folder.active").forEach((el) => el.classList.remove("active"));
    showList();
    $("#list-title").textContent = `Suche: „${q}“`;
    $("#article-list").innerHTML = '<div class="empty"><span class="spinner"></span>Suche…</div>';
    try {
      let results;
      if (state.allLoaded) {
        const ql = q.toLowerCase();
        results = [];
        for (const arr of state.articlesByFolder.values()) {
          for (const a of arr) {
            const hay = `${a.title} ${a.description_text || stripHtml(a.description)} ${(a.tags || []).join(" ")} ${(a.keywords || []).join(" ")}`.toLowerCase();
            if (hay.includes(ql)) results.push(a);
          }
        }
        // dedupe (map stores both numeric and string keys)
        const seen = new Set();
        results = results.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
      } else {
        const data = await api(`/api/fs/articles/search?q=${encodeURIComponent(q)}`);
        results = data.articles;
      }
      state.listItems = results;
      $("#list-title").textContent = `Suche: „${q}“ (${results.length})${state.allLoaded ? "" : " – Freshservice-Suche"}`;
      renderList();
    } catch (e) {
      $("#article-list").innerHTML = `<div class="empty"><div class="msg msg-err">${esc(e.message)}</div></div>`;
    }
  });

  // ---------------------------------------------------------------- tags
  function buildTagCloud() {
    const counts = new Map();
    const seen = new Set();
    for (const arr of state.articlesByFolder.values()) {
      for (const a of arr) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        for (const t of a.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    $("#tags-count").textContent = tags.length ? `${tags.length}` : "";
    const cloud = $("#tag-cloud");
    if (!tags.length) {
      cloud.innerHTML = '<div class="muted small pad">Keine Tags vergeben.</div>';
      return;
    }
    cloud.innerHTML = tags.map(([t, n]) => `<span class="tag-pill" data-tag="${esc(t)}">${esc(t)}<b>${n}</b></span>`).join("");
    $$(".tag-pill", cloud).forEach((p) => p.addEventListener("click", () => selectTag(p.dataset.tag)));
  }

  function selectTag(tag) {
    state.activeTag = tag;
    state.listMode = "tag";
    state.selectedFolderId = null;
    $$(".tree-folder.active").forEach((el) => el.classList.remove("active"));
    $$("#tag-cloud .tag-pill").forEach((p) => p.classList.toggle("active", p.dataset.tag === tag));
    const seen = new Set();
    const items = [];
    for (const arr of state.articlesByFolder.values()) for (const a of arr) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      if ((a.tags || []).includes(tag)) items.push(a);
    }
    state.listItems = items;
    $("#list-title").textContent = `Tag: ${tag} (${items.length})`;
    showList();
    renderList();
  }

  // ---------------------------------------------------------------- article detail
  async function openArticle(id) {
    $("#list-panel").classList.add("hidden");
    $("#detail-panel").classList.remove("hidden");
    $("#detail-title").textContent = "Lade…";
    $("#detail-body").innerHTML = "";
    $("#detail-meta").innerHTML = "";
    $("#detail-tags").innerHTML = "";
    try {
      const [{ article }] = await Promise.all([api(`/api/fs/articles/${id}`), loadAgents().catch(() => null)]);
      state.selectedArticle = article;
      renderDetail(article);
    } catch (e) {
      $("#detail-title").textContent = "Fehler";
      $("#detail-body").innerHTML = `<div class="msg msg-err">${esc(e.message)}</div>`;
    }
  }

  function renderDetail(a) {
    const [sLabel, sCls] = STATUS[a.status] || ["?", "badge-type"];
    const folder = folderById(a.folder_id);
    $("#detail-title").textContent = a.title;
    $("#detail-meta").innerHTML = `
      <span class="badge ${sCls}">${sLabel}</span>
      <span class="badge badge-type">${TYPE[a.article_type] || "–"}</span>
      ${folder ? `<span>📁 ${esc(folder.category?.name)} / ${esc(folder.name)}</span>` : `<span>Ordner-ID ${a.folder_id}</span>`}
      <span>ID ${a.id}</span>
      ${a.agent_id ? `<span>✍ ${esc(agentLabel(a.agent_id))}</span>` : ""}
      <span>Erstellt: ${fmtDate(a.created_at)}</span>
      <span>Geändert: ${fmtDate(a.updated_at)}</span>
      ${a.views != null ? `<span>👁 ${a.views}</span>` : ""}
      ${a.thumbs_up != null ? `<span>👍 ${a.thumbs_up} 👎 ${a.thumbs_down ?? 0}</span>` : ""}
      ${a.review_date ? `<span>Review: ${fmtDate(a.review_date)}</span>` : ""}
      ${a.approval_status != null ? `<span>Freigabe-Status: ${a.approval_status}</span>` : ""}`;
    $("#detail-tags").innerHTML =
      (a.tags || []).map((t) => `<span class="tag-pill clickable" data-tag="${esc(t)}">🏷 ${esc(t)}</span>`).join("") +
      (a.keywords || []).map((k) => `<span class="tag-pill" title="Keyword">🔍 ${esc(k)}</span>`).join("");
    $$("#detail-tags .clickable").forEach((p) => p.addEventListener("click", () => {
      if (!state.allLoaded) return toast("Für Tag-Filter erst „Alle Artikel laden“.", "");
      selectTag(p.dataset.tag);
    }));
    $("#detail-body").innerHTML = sanitize(displayHtml(a.description || "", a.id));
    $("#detail-html").textContent = a.description || "";
    const base = fsBaseUrl();
    const link = $("#detail-open-fs");
    if (base) { link.href = `${base}/a/solutions/articles/${a.id}`; link.classList.remove("hidden"); } else link.classList.add("hidden");
  }

  $("#btn-detail-back").addEventListener("click", showList);
  $("#btn-detail-edit").addEventListener("click", () => {
    if (state.selectedArticle) openEditor({ mode: "edit", article: state.selectedArticle });
  });
  $("#btn-detail-delete").addEventListener("click", async () => {
    const a = state.selectedArticle;
    if (!a) return;
    if (!confirm(`Artikel „${a.title}“ wirklich in Freshservice löschen?`)) return;
    try {
      await api(`/api/fs/articles/${a.id}`, { method: "DELETE" });
      toast("Artikel gelöscht", "ok");
      const arr = state.articlesByFolder.get(Number(a.folder_id));
      if (arr) {
        const idx = arr.findIndex((x) => x.id === a.id);
        if (idx >= 0) arr.splice(idx, 1);
      }
      state.listItems = state.listItems.filter((x) => x.id !== a.id);
      showList();
      renderList();
      if (state.allLoaded) buildTagCloud();
    } catch (e) {
      toast(e.message, "err");
    }
  });

  // ---------------------------------------------------------------- editor (TinyMCE)
  /** TinyMCE images_upload_handler: send the image to the local temp store, return the URL to embed. */
  async function uploadEditorImage(blobInfo, progress) {
    const blob = blobInfo.blob();
    progress?.(10);
    const res = await fetch("/api/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: blobInfo.filename(), mime: blob.type || "image/png", data: blobInfo.base64() }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Upload fehlgeschlagen (${res.status})`);
    progress?.(100);
    return json.url;
  }

  function ensureTinyMce() {
    if (state.editor.tinyReady || !window.tinymce) return;
    state.editor.tinyReady = true;
    tinymce.init({
      selector: "#editor-body",
      license_key: "gpl",
      height: 620,
      menubar: "edit view insert format table tools",
      plugins: "lists link image table code codesample autolink searchreplace wordcount fullscreen visualblocks anchor charmap preview",
      toolbar:
        "undo redo | blocks | bold italic underline strikethrough | forecolor backcolor | link image table | bullist numlist outdent indent | blockquote codesample | removeformat | code visualblocks preview fullscreen",
      block_formats: "Absatz=p; Überschrift 2=h2; Überschrift 3=h3; Überschrift 4=h4; Vorformatiert=pre",
      promotion: false,
      branding: false,
      convert_urls: false,
      relative_urls: false,
      remove_script_host: false,
      // Images: upload tab in the image dialog, paste (Ctrl+V) and drag & drop all go through
      // images_upload_handler → temporary local store → attached to the Freshservice article on save.
      images_upload_handler: uploadEditorImage,
      automatic_uploads: true,
      paste_data_images: true,
      images_file_types: "jpeg,jpg,png,gif,webp",
      image_title: true,
      image_dimensions: true,
      image_caption: false,
      // keep the Freshservice-specific attributes the KI agent produces (code blocks, intro paragraph id)
      extended_valid_elements:
        "pre[code-brush|data-code-brush|rel|contenteditable|eventadded|class|style],p[id|class|style],div[class|style|contenteditable]",
      valid_children: "+div[pre|p]",
      table_default_attributes: { border: "1" },
      table_default_styles: { "border-collapse": "collapse", width: "100%" },
      content_style:
        "body{font-family:Segoe UI,system-ui,sans-serif;font-size:15px;line-height:1.55;max-width:900px;margin:12px auto;padding:0 8px} " +
        "table{border-collapse:collapse} td,th{border:1px solid #cbd5e1;padding:6px 10px} th{background:#f1f4f8} " +
        "blockquote{border-left:4px solid #cbd5e1;margin:12px 0;padding:6px 14px;background:#f8fafc} pre{background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px}",
      setup(ed) {
        ed.on("init", () => {
          if (state.editor.pendingHtml !== null) {
            ed.setContent(state.editor.pendingHtml || "");
            state.editor.pendingHtml = null;
          }
        });
      },
    });
  }

  function setEditorHtml(html) {
    const ed = window.tinymce && tinymce.get("editor-body");
    if (ed && ed.initialized) ed.setContent(html || "");
    else state.editor.pendingHtml = html || "";
  }
  async function getEditorHtml() {
    const ed = window.tinymce && tinymce.get("editor-body");
    if (!ed) return $("#editor-body").value;
    try { await ed.uploadImages(); } catch { /* pending uploads failing surface as broken images; save continues */ }
    return ed.getContent();
  }

  function imagesToast(base, images) {
    return images?.attached ? `${base} – ${images.attached} Bild(er) als Anhang hochgeladen` : base;
  }

  function openEditor({ mode, article = null, prefill = null }) {
    state.editor.mode = mode;
    state.editor.articleId = article?.id || null;
    $("#editor-heading").textContent = mode === "edit" ? `Artikel bearbeiten (ID ${article.id})` : "Neuer Artikel";
    setStatus("#editor-status", "");
    const src = article || prefill || {};
    $("#ed-title").value = src.title || "";
    $("#ed-status").value = String(src.status || 1);
    $("#ed-type").value = String(src.article_type || 1);
    $("#ed-tags").value = (src.tags || []).join(", ");
    $("#ed-keywords").value = (src.keywords || []).join(", ");
    $("#ed-review").value = src.review_date ? String(src.review_date).slice(0, 10) : "";
    // category/folder
    const folder = folderById(src.folder_id || state.selectedFolderId);
    if (folder) {
      $("#ed-category").value = String(folder.category.id);
      fillEditorFolders(folder.id);
    } else {
      fillEditorFolders();
    }
    // author: new article → my identity; existing article → the "Author: …" byline if present (Freshservice usually keeps
    // the API user as agent_id, so the byline is the reliable signal), otherwise the article's agent_id
    const authorSel = $("#ed-author");
    const resolveEditAuthor = () => {
      if (mode !== "edit") return state.settings?.authorAgentId || "";
      const m = String(article?.description || "").match(/<p[^>]*>\s*<em>\s*Author:\s*([^<]+?)\s*<\/em>\s*<\/p>\s*$/i);
      if (m) {
        const byName = (state.agents || []).find((a) => a.name.toLowerCase() === m[1].trim().toLowerCase());
        if (byName) return String(byName.id);
      }
      return article?.agent_id ?? "";
    };
    const wantAuthor = resolveEditAuthor();
    authorSel.innerHTML = `<option value="${esc(wantAuthor)}">${wantAuthor ? esc(agentLabel(wantAuthor) || state.settings?.authorName || `Agent #${wantAuthor}`) : "– API-Benutzer (Standard von Freshservice) –"}</option>`;
    loadAgents().then(() => fillAuthorSelect(authorSel, resolveEditAuthor())).catch(() => { /* keep minimal option */ });
    showView("editor");
    setEditorHtml(displayHtml(src.description || "", article?.id));
    setTimeout(() => $("#ed-title").focus(), 50);
  }

  $("#btn-editor-cancel").addEventListener("click", () => {
    showView("browse");
  });

  $("#btn-editor-save").addEventListener("click", async () => {
    const title = $("#ed-title").value.trim();
    const description = (await getEditorHtml()).trim();
    const folder_id = $("#ed-folder").value;
    if (!title) return setStatus("#editor-status", "Titel fehlt.", "err");
    if (!description) return setStatus("#editor-status", "Inhalt fehlt.", "err");
    if (!folder_id) return setStatus("#editor-status", "Bitte einen Ordner wählen (ggf. erst Struktur laden).", "err");
    const payload = {
      title,
      description,
      folder_id: Number(folder_id),
      status: Number($("#ed-status").value),
      article_type: Number($("#ed-type").value),
      tags: splitList($("#ed-tags").value),
      keywords: splitList($("#ed-keywords").value),
      review_date: $("#ed-review").value || undefined,
      ...authorPayload($("#ed-author").value),
    };
    const btn = $("#btn-editor-save");
    btn.disabled = true;
    setStatus("#editor-status", '<span class="spinner"></span>Speichere in Freshservice…', "info");
    try {
      let article, images, r;
      if (state.editor.mode === "edit" && state.editor.articleId) {
        r = await api(`/api/fs/articles/${state.editor.articleId}`, { method: "PUT", body: payload });
        ({ article, images } = r);
        toast(authorResultToast(imagesToast("Artikel aktualisiert", images), r), "ok");
      } else {
        r = await api("/api/fs/articles", { method: "POST", body: payload });
        ({ article, images } = r);
        toast(authorResultToast(imagesToast("Artikel angelegt", images), r), "ok");
      }
      if (images?.unmapped?.length || images?.missing?.length) {
        const parts = [];
        if (images.unmapped?.length) parts.push(`${images.unmapped.length} Bild(er) konnten nicht zu Freshservice übertragen werden (${images.unmapped.join(", ")}) – in Freshservice fehlt das Bild; bitte Artikel erneut speichern, der Upload wird wiederholt.`);
        if (images.missing?.length) parts.push(`${images.missing.length} Bild(er) sind auf dem Server nicht mehr vorhanden (z. B. nach Neustart) – bitte das Bild im Editor erneut einfügen und speichern.`);
        toast("Achtung: " + parts.join(" "), "err");
      }
      // refresh folder cache & show
      await loadFolderArticles(article.folder_id, true);
      if (state.allLoaded) buildTagCloud();
      state.selectedFolderId = article.folder_id;
      renderTree();
      showView("browse");
      await selectFolder(article.folder_id);
      openArticle(article.id);
    } catch (e) {
      setStatus("#editor-status", esc(e.message) + (e.details ? `<br><small>${esc(JSON.stringify(e.details))}</small>` : ""), "err");
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------------------------------------------------------- AI
  function aiSetBusy(busy, msg) {
    state.ai.busy = busy;
    $("#btn-ai-generate").disabled = busy;
    $("#btn-ai-change").disabled = busy;
    $("#btn-ai-insert").disabled = busy;
    // only the busy state writes the status box; error/success messages set by the caller must survive aiSetBusy(false)
    if (busy) setStatus("#ai-status", `<span class="spinner"></span>${msg || "ChatGPT arbeitet…"}`, "info");
  }

  function aiRenderArticle(article) {
    state.ai.article = article;
    $("#ai-empty").classList.add("hidden");
    $("#ai-result").classList.remove("hidden");
    $("#ai-title").textContent = article.title || "";
    $("#ai-tags").innerHTML =
      (article.tags || []).map((t) => `<span class="tag-pill">🏷 ${esc(t)}</span>`).join("");
    $("#ai-preview").innerHTML = sanitize(displayHtml(article.description_html || ""));
    $("#ai-html").textContent = article.description_html || "";
    $("#ai-notes").textContent = article.notes_for_reviewer || "–";
    $("#ai-keywords").textContent = (article.keywords || []).length ? `Keywords: ${article.keywords.join(", ")}` : "";
    const sel = $("#ai-insert-folder");
    const chosen = $("#ai-folder").value || (article.suggested_folder_id != null ? String(article.suggested_folder_id) : "");
    if (chosen && $(`option[value="${chosen}"]`, sel)) sel.value = chosen;
    $("#ai-conversation").classList.remove("hidden");
  }

  function aiLog(role, text) {
    const log = $("#ai-log");
    const div = document.createElement("div");
    div.className = `turn ${role === "user" ? "turn-user" : "turn-ai"}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  $$(".seg-btn").forEach((b) =>
    b.addEventListener("click", () => {
      $$(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
      const html = b.dataset.mode === "html";
      $("#ai-preview").classList.toggle("hidden", html);
      $("#ai-html").classList.toggle("hidden", !html);
    })
  );

  $("#btn-ai-generate").addEventListener("click", async () => {
    const description = $("#ai-description").value.trim();
    if (!description) return setStatus("#ai-status", "Bitte eine Beschreibung eingeben.", "err");
    if (!state.config?.hasOpenaiKey) return setStatus("#ai-status", "Kein OpenAI-API-Key hinterlegt (⚙ Einstellungen).", "err");

    const targetFolderId = $("#ai-folder").value;
    const targetFolder = targetFolderId ? folderById(targetFolderId) : null;
    const body = {
      messages: [],
      description,
      language: $("#ai-language").value || undefined,
      targetFolder: targetFolder ? { id: targetFolder.id, name: targetFolder.name, category: targetFolder.category?.name } : undefined,
    };
    if ($("#ai-ctx-folders").checked && state.categories.length) {
      body.folders = state.categories.flatMap((c) => c.folders.map((f) => ({ id: f.id, name: f.name, category: c.name })));
    }
    if ($("#ai-ctx-titles").checked && targetFolder) {
      try {
        const arts = await loadFolderArticles(targetFolder.id);
        body.exampleArticles = arts.slice(0, 20).map((a) => ({ title: a.title }));
      } catch { /* optional context */ }
    }

    aiSetBusy(true, "ChatGPT erstellt den Artikel… (je nach Modell/Effort 15–90 s)");
    $("#ai-log").innerHTML = "";
    try {
      const r = await api("/api/ai/generate", { method: "POST", body });
      state.ai.messages = r.messages;
      aiLog("user", description);
      aiLog("ai", `Artikel „${r.article.title}“ erstellt (${r.model}${r.usage ? `, ${r.usage.output_tokens} Output-Tokens` : ""}).`);
      aiRenderArticle(r.article);
      $("#ai-input-block").classList.add("hidden");
      setStatus("#ai-status", "");
    } catch (e) {
      setStatus("#ai-status", esc(e.message), "err");
    } finally {
      aiSetBusy(false);
    }
  });

  $("#btn-ai-change").addEventListener("click", async () => {
    const changeRequest = $("#ai-change").value.trim();
    if (!changeRequest) return setStatus("#ai-status", "Bitte einen Änderungswunsch eingeben.", "err");
    // if the reviewer edited the title inline, tell the model
    const editedTitle = $("#ai-title").textContent.trim();
    const extra = state.ai.article && editedTitle && editedTitle !== state.ai.article.title ? `\n\n(Der Reviewer hat den Titel manuell auf „${editedTitle}“ geändert – behalte diesen Titel bei, sofern der Änderungswunsch nichts anderes sagt.)` : "";
    aiSetBusy(true, "ChatGPT überarbeitet den Artikel…");
    try {
      const r = await api("/api/ai/generate", { method: "POST", body: { messages: state.ai.messages, changeRequest: changeRequest + extra } });
      state.ai.messages = r.messages;
      aiLog("user", changeRequest);
      aiLog("ai", `Überarbeitet: „${r.article.title}“.${r.article.notes_for_reviewer ? " " + r.article.notes_for_reviewer : ""}`);
      aiRenderArticle(r.article);
      $("#ai-change").value = "";
      setStatus("#ai-status", "");
    } catch (e) {
      setStatus("#ai-status", esc(e.message), "err");
    } finally {
      aiSetBusy(false);
    }
  });

  $("#btn-ai-reset").addEventListener("click", () => {
    if (state.ai.messages.length && !confirm("Aktuellen KI-Entwurf verwerfen und neu starten?")) return;
    state.ai.messages = [];
    state.ai.article = null;
    $("#ai-log").innerHTML = "";
    $("#ai-conversation").classList.add("hidden");
    $("#ai-input-block").classList.remove("hidden");
    $("#ai-result").classList.add("hidden");
    $("#ai-empty").classList.remove("hidden");
    setStatus("#ai-status", "");
  });

  function aiCurrentDraft() {
    const a = state.ai.article;
    if (!a) return null;
    return {
      title: $("#ai-title").textContent.trim() || a.title,
      description: a.description_html,
      tags: a.tags || [],
      keywords: a.keywords || [],
      folder_id: Number($("#ai-insert-folder").value) || a.suggested_folder_id || state.selectedFolderId,
    };
  }

  $("#btn-ai-open-editor").addEventListener("click", () => {
    const d = aiCurrentDraft();
    if (!d) return;
    openEditor({ mode: "create", prefill: { ...d, status: Number($("#ai-insert-status").value), article_type: 1 } });
  });

  $("#btn-ai-insert").addEventListener("click", async () => {
    const d = aiCurrentDraft();
    if (!d) return;
    if (!d.folder_id) return setStatus("#ai-status", "Bitte einen Ziel-Ordner wählen.", "err");
    const status = Number($("#ai-insert-status").value);
    const folder = folderById(d.folder_id);
    if (!confirm(`Artikel „${d.title}“ ${status === 2 ? "VERÖFFENTLICHT" : "als Entwurf"} in Ordner „${folder?.name || d.folder_id}“ anlegen?`)) return;
    aiSetBusy(true, "Lege Artikel in Freshservice an…");
    try {
      const r = await api("/api/fs/articles", {
        method: "POST",
        body: { ...d, status, article_type: 1, ...authorPayload() },
      });
      const { article } = r;
      toast(authorResultToast(`Artikel angelegt (ID ${article.id})`, r), "ok");
      await loadFolderArticles(article.folder_id, true);
      if (state.allLoaded) buildTagCloud();
      renderTree();
      showView("browse");
      await selectFolder(article.folder_id);
      openArticle(article.id);
      // reset AI panel for next article
      state.ai.messages = [];
      state.ai.article = null;
      $("#ai-log").innerHTML = "";
      $("#ai-conversation").classList.add("hidden");
      $("#ai-input-block").classList.remove("hidden");
      $("#ai-description").value = "";
      $("#ai-result").classList.add("hidden");
      $("#ai-empty").classList.remove("hidden");
      setStatus("#ai-status", "");
    } catch (e) {
      setStatus("#ai-status", esc(e.message) + (e.details ? `<br><small>${esc(JSON.stringify(e.details))}</small>` : ""), "err");
    } finally {
      aiSetBusy(false);
    }
  });

  // ---------------------------------------------------------------- init
  (async function init() {
    state.settings = loadSettings();
    const hadSettingsBefore = Boolean(state.settings.freshserviceApiKey || state.settings.freshserviceDomain);
    syncAttachmentCookie(); // cookie for <img> attachment previews (path-scoped, browser-only)
    unregisterLegacyServiceWorker();
    await loadConfig();
    if (!state.config.hasFreshserviceKey || !state.config.freshserviceDomain) {
      openModal("modal-settings");
    }
    await loadTree();
    // existing users after the author update (or ENV-configured users) → ask once who they are
    maybeAskIdentity(hadSettingsBefore || Boolean(state.config.keySources?.freshservice === "env"));
  })();
})();
