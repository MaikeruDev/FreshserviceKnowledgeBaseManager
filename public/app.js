/* Fresh Knowledge Manager – frontend */
(() => {
  "use strict";

  // ---------------------------------------------------------------- state
  const state = {
    config: null,
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

  // ---------------------------------------------------------------- utils
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
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
    toastTimer = setTimeout(() => el.classList.add("hidden"), kind === "err" ? 7000 : 3500);
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

  function fsBaseUrl() {
    const d = state.config?.freshserviceDomain || "";
    if (!d) return "";
    return `https://${d.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
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
  async function loadConfig() {
    state.config = await api("/api/config");
    const chip = $("#conn-chip");
    if (state.config.freshserviceDomain && state.config.hasFreshserviceKey) {
      chip.textContent = state.config.freshserviceDomain;
      chip.className = "chip chip-ok";
    } else {
      chip.textContent = "nicht konfiguriert";
      chip.className = "chip chip-warn";
    }
    $("#cfg-domain").value = state.config.freshserviceDomain || "";
    $("#cfg-workspace").value = state.config.freshserviceWorkspaceId || "";
    $("#cfg-model").value = state.config.aiModel || "gpt-5.5";
    $("#cfg-effort").value = state.config.aiEffort || "medium";
    $("#cfg-fs-hint").textContent = state.config.hasFreshserviceKey ? `(gespeichert${state.config.keySources.freshservice === "env" ? ", aus ENV" : ""})` : "(nicht gesetzt)";
    $("#cfg-ai-hint").textContent = state.config.hasOpenaiKey ? `(gespeichert${state.config.keySources.openai === "env" ? ", aus ENV" : ""})` : "(nicht gesetzt)";
  }

  function openModal(id) { $(`#${id}`).classList.remove("hidden"); }
  function closeModal(id) { $(`#${id}`).classList.add("hidden"); }
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => closeModal(b.dataset.close)));
  $$(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.classList.add("hidden"); }));

  $("#btn-settings").addEventListener("click", () => { setStatus("#cfg-test-result", ""); openModal("modal-settings"); });

  $("#btn-cfg-save").addEventListener("click", async () => {
    try {
      await api("/api/config", {
        method: "POST",
        body: {
          freshserviceDomain: $("#cfg-domain").value,
          freshserviceApiKey: $("#cfg-fs-key").value,
          freshserviceWorkspaceId: $("#cfg-workspace").value,
          openaiApiKey: $("#cfg-ai-key").value,
          aiModel: $("#cfg-model").value,
          aiEffort: $("#cfg-effort").value,
        },
      });
      $("#cfg-fs-key").value = "";
      $("#cfg-ai-key").value = "";
      await loadConfig();
      toast("Einstellungen gespeichert", "ok");
      closeModal("modal-settings");
      await loadTree(true);
    } catch (e) {
      setStatus("#cfg-test-result", esc(e.message), "err");
    }
  });

  $("#btn-cfg-test").addEventListener("click", async () => {
    setStatus("#cfg-test-result", '<span class="spinner"></span>Teste… (speichere vorher, falls du Werte geändert hast)', "info");
    try {
      const r = await api("/api/config/test", { method: "POST" });
      const parts = [];
      parts.push(r.freshservice?.ok
        ? `<div class="msg msg-ok">Freshservice OK – ${r.freshservice.categories} Kategorien unter ${esc(r.freshservice.baseUrl)}</div>`
        : `<div class="msg msg-err">Freshservice: ${esc(r.freshservice?.error)}</div>`);
      parts.push(r.openai?.ok
        ? `<div class="msg msg-ok">OpenAI OK – Modell ${esc(r.openai.model)}</div>`
        : `<div class="msg msg-err">OpenAI: ${esc(r.openai?.error)}</div>`);
      $("#cfg-test-result").innerHTML = parts.join("");
    } catch (e) {
      setStatus("#cfg-test-result", esc(e.message), "err");
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
      const { article } = await api(`/api/fs/articles/${id}`);
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
    $("#detail-body").innerHTML = sanitize(a.description || "");
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
      paste_data_images: false,
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
  function getEditorHtml() {
    const ed = window.tinymce && tinymce.get("editor-body");
    return ed ? ed.getContent() : $("#editor-body").value;
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
    showView("editor");
    setEditorHtml(src.description || "");
    setTimeout(() => $("#ed-title").focus(), 50);
  }

  $("#btn-editor-cancel").addEventListener("click", () => {
    showView("browse");
  });

  $("#btn-editor-save").addEventListener("click", async () => {
    const title = $("#ed-title").value.trim();
    const description = getEditorHtml().trim();
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
    };
    const btn = $("#btn-editor-save");
    btn.disabled = true;
    setStatus("#editor-status", '<span class="spinner"></span>Speichere in Freshservice…', "info");
    try {
      let article;
      if (state.editor.mode === "edit" && state.editor.articleId) {
        ({ article } = await api(`/api/fs/articles/${state.editor.articleId}`, { method: "PUT", body: payload }));
        toast("Artikel aktualisiert", "ok");
      } else {
        ({ article } = await api("/api/fs/articles", { method: "POST", body: payload }));
        toast("Artikel angelegt", "ok");
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
    $("#ai-preview").innerHTML = sanitize(article.description_html || "");
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
      const { article } = await api("/api/fs/articles", {
        method: "POST",
        body: { ...d, status, article_type: 1 },
      });
      toast(`Artikel angelegt (ID ${article.id})`, "ok");
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
    try {
      await loadConfig();
    } catch (e) {
      toast("Server nicht erreichbar: " + e.message, "err");
      return;
    }
    if (!state.config.hasFreshserviceKey || !state.config.freshserviceDomain) {
      openModal("modal-settings");
    }
    await loadTree();
  })();
})();
