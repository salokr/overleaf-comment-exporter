/* Overleaf Comment Exporter — popup controller + injected page scanner. */

// ===========================================================================
// This function is injected into the Overleaf page (MAIN world) and runs there.
// It must be fully self-contained (no references to outside variables).
// Returns a summary object; performs the file downloads itself, in-page.
// ===========================================================================
async function olceScan(opts) {
  const CFG = {
    scanAllFiles: opts.scope === "all",
    formats: opts.formats, // {md, csv, json}
    topTolerance: 60,
    scrollStepRatio: 0.8,
    scrollDelayMs: 140,
    settleMs: 450,
    fileLoadTimeoutMs: 8000,
    fileExtensions: /\.(tex|bib|txt|md|sty|cls|bbl|Rnw)$/i,
    maxFiles: 300,
    prefix: "overleaf_comments",
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s ?? "")
    .replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const norm = (s) => clean(s).replace(/\s+/g, " ");
  const safeName = (s) => (s || "overleaf").replace(/[^\w.-]+/g, "_").slice(0, 90);
  const getCurrentFile = () => clean(
    $$(".ol-cm-breadcrumbs div").map((x) => x.textContent).filter(Boolean).join("/")
  );

  const projectId =
    (location.pathname.match(/\/project\/([0-9a-f]{24})/) || [])[1] ||
    $('meta[name="ol-project_id"]')?.content ||
    $('meta[name="ol-projectId"]')?.content;
  if (!projectId) return { ok: false, error: "No Overleaf project detected on this tab." };

  const projectName = clean(
    $('meta[name="ol-projectName"]')?.content || document.title || "Overleaf project"
  );

  // Progress published to a page global; the popup polls it.
  const P = (patch) => { window.__olceProgress = Object.assign(window.__olceProgress || {}, patch); };
  window.__olceProgress = {
    phase: "reading", overall: 0.03, fileIndex: 0, fileTotal: 0,
    fileName: "Reading comments…", fileProgress: 0, done: false,
  };

  // ---- 1. all threads (full comment content) -------------------------------
  let threadsRaw = {};
  try {
    const res = await fetch(`/project/${projectId}/threads`, {
      headers: { Accept: "application/json" }, credentials: "include",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    threadsRaw = await res.json();
  } catch (e) {
    console.warn("[exporter] /threads fetch failed, using DOM only:", e);
  }
  const threads = Object.entries(threadsRaw).map(([id, t]) => {
    const messages = (t?.messages || []).map((m) => ({
      content: clean(m.content),
      timestamp: m.timestamp ? new Date(m.timestamp).toLocaleString() : "",
      author: clean(
        [m.user?.first_name, m.user?.last_name].filter(Boolean).join(" ") ||
        m.user?.email || m.user_id || ""
      ),
    })).filter((m) => m.content);
    return {
      id, resolved: !!t?.resolved,
      resolvedAt: t?.resolved_at ? new Date(t.resolved_at).toLocaleString() : "",
      messages, rootBody: messages[0]?.content || "",
    };
  }).filter((t) => t.messages.length);

  // ---- 2. harvest one open file -------------------------------------------
  async function harvestOpenFile(onProgress) {
    const scroller = $(".cm-scroller");
    const cmContent = $(".cm-content");
    const entryMap = new Map();
    const highlightMap = new Map();
    const contentTop = () => cmContent?.getBoundingClientRect().top ?? 0;

    function harvestEntries() {
      const root = $("#review-panel-current-file") || $(".review-panel-container") || document;
      for (const el of $$(".review-panel-entry-comment", root)) {
        const notes = $$(".review-panel-comment", el).map((box) => ({
          author: clean($(".review-panel-entry-user", box)?.textContent),
          time: clean($(".review-panel-entry-time", box)?.textContent),
          body: clean(
            $(".review-panel-comment-body", box)?.textContent ||
            $(".review-panel-expandable-content", box)?.textContent
          ),
        })).filter((n) => n.body);
        if (!notes.length) continue;
        const pos = Number(el.dataset.pos);
        const top = Number(el.dataset.top);
        const key = `${Number.isFinite(pos) ? pos : ""}|${norm(notes[0].body)}`;
        if (!entryMap.has(key)) entryMap.set(key, { pos, top, notes });
      }
    }
    function harvestHighlights() {
      const ct = contentTop();
      const sel = ".cm-content .ol-cm-change-c, .cm-content .ol-cm-change-highlight-c, .cm-content .ol-cm-change-focus-c";
      for (const el of $$(sel)) {
        const text = clean(el.textContent);
        if (!text) continue;
        const rect = (Array.from(el.getClientRects()).find((r) => r.width && r.height)) || el.getBoundingClientRect();
        const top = rect.top - ct;
        const context = clean(el.closest(".cm-line")?.textContent || "");
        const key = `${Math.round(top)}|${norm(text)}`;
        if (!highlightMap.has(key)) highlightMap.set(key, { top, text, context });
      }
    }

    if (scroller) {
      const original = scroller.scrollTop;
      const step = Math.max(200, scroller.clientHeight * CFG.scrollStepRatio);
      const span = Math.max(1, scroller.scrollHeight);
      harvestEntries(); harvestHighlights();
      for (let y = 0; y <= scroller.scrollHeight; y += step) {
        scroller.scrollTop = y;
        await sleep(CFG.scrollDelayMs);
        harvestEntries(); harvestHighlights();
        if (onProgress) onProgress(Math.min(1, y / span));
      }
      scroller.scrollTop = original;
      if (onProgress) onProgress(1);
    } else {
      harvestEntries(); harvestHighlights();
      if (onProgress) onProgress(1);
    }

    const highlights = Array.from(highlightMap.values());
    const fragmentFor = (entry) => {
      if (!Number.isFinite(entry.top)) return null;
      let best = null;
      for (const h of highlights) {
        const d = Math.abs(h.top - entry.top);
        if (d > CFG.topTolerance) continue;
        if (!best || d < Math.abs(best.top - entry.top)) best = h;
      }
      return best;
    };
    return Array.from(entryMap.values()).map((entry) => {
      const h = fragmentFor(entry);
      return {
        fragment: h?.text || "", context: h?.context || "",
        pos: entry.pos, notes: entry.notes, rootBody: norm(entry.notes[0].body),
      };
    });
  }

  // ---- 2b. file-tree walking ----------------------------------------------
  function findFiles() {
    const root = $(".file-tree") || $('[class*="file-tree"]') || document;
    const leafName = (el) => {
      const aria = el.getAttribute && el.getAttribute("aria-label");
      const txt = clean(aria || el.textContent || "");
      return txt.split("\n").map((s) => s.trim()).filter(Boolean).pop() || "";
    };
    const candidates = $$(
      '[role="treeitem"], li.entity .entity-name, .file-tree-list button, .file-tree li button, .file-tree li',
      root
    );
    const seen = new Map();
    for (const el of candidates) {
      if (el.querySelector && el.querySelector("ul")) continue;
      const name = leafName(el);
      if (!CFG.fileExtensions.test(name)) continue;
      if (!seen.has(name)) seen.set(name, { el, name });
    }
    return Array.from(seen.values()).slice(0, CFG.maxFiles);
  }
  function clickFile(el) {
    const target = (el.tagName === "BUTTON" ? el : null) || el.querySelector?.("button") || el;
    target.scrollIntoView?.({ block: "center" });
    target.click();
  }
  async function waitForFile(name) {
    const deadline = Date.now() + CFG.fileLoadTimeoutMs;
    while (Date.now() < deadline) {
      const cur = getCurrentFile();
      if (cur && cur.endsWith(name)) return true;
      await sleep(120);
    }
    return false;
  }
  async function scanAllFiles() {
    const files = findFiles();
    if (!files.length) return null;
    P({ phase: "scanning", fileTotal: files.length });
    const startName = getCurrentFile();
    const out = [];
    const total = files.length;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      P({ fileIndex: i + 1, fileName: f.name, fileProgress: 0, overall: (i / total) * 0.9 });
      try {
        clickFile(f.el);
        if (!(await waitForFile(f.name))) continue;
        await sleep(CFG.settleMs);
        const entries = await harvestOpenFile((frac) =>
          P({ fileProgress: frac, overall: ((i + frac) / total) * 0.9 }));
        out.push({ file: f.name, entries });
      } catch (e) { console.warn("[exporter] file error", f.name, e); }
      P({ fileProgress: 1, overall: ((i + 1) / total) * 0.9 });
    }
    const orig = files.find((f) => startName.endsWith(f.name));
    if (orig) { try { clickFile(orig.el); await waitForFile(orig.name); } catch {} }
    return out;
  }

  // ---- 2c. make sure the Review panel is open (best-effort) ----------------
  function reviewPanelOpen() {
    const el = $("#review-panel-current-file") || $(".review-panel-container") || $(".review-panel");
    return !!(el && el.offsetParent !== null);
  }
  async function ensureReviewPanel() {
    if (reviewPanelOpen()) return true;
    // Try likely toggles, stopping as soon as the panel appears.
    const seen = new Set();
    const tries = [
      ...$$('[aria-label*="review" i], [title*="review" i], button[class*="review" i], button[class*="track-change" i]'),
      ...$$("button, a").filter((b) => /^\s*review\s*$/i.test(b.textContent || "")),
    ];
    for (const c of tries) {
      if (seen.has(c)) continue;
      seen.add(c);
      try { c.click(); } catch {}
      for (let i = 0; i < 8; i++) { await sleep(150); if (reviewPanelOpen()) return true; }
    }
    return reviewPanelOpen();
  }

  // ---- 3. run + merge ------------------------------------------------------
  const panelOpen = await ensureReviewPanel();
  let fileGroups = null;
  let fellBack = false;
  if (CFG.scanAllFiles) {
    fileGroups = await scanAllFiles();
    if (!fileGroups) fellBack = true;
  }
  if (!fileGroups) {
    const name = getCurrentFile() || "current file";
    P({ phase: "scanning", fileTotal: 1, fileIndex: 1, fileName: name, fileProgress: 0 });
    const entries = await harvestOpenFile((frac) => P({ fileProgress: frac, overall: frac * 0.9 }));
    fileGroups = [{ file: name, entries }];
  }

  P({ phase: "formatting", overall: 0.94 });

  const KEY_LEN = 60;
  const keyOf = (body) => norm(body).slice(0, KEY_LEN);
  const locByKey = new Map();
  for (const grp of fileGroups) {
    for (const a of grp.entries) {
      const k = keyOf(a.rootBody);
      if (k && !locByKey.has(k)) locByKey.set(k, { file: grp.file, fragment: a.fragment, context: a.context, pos: a.pos });
    }
  }

  const records = [];
  if (threads.length) {
    for (const t of threads) {
      const loc = locByKey.get(keyOf(t.rootBody));
      records.push({
        threadId: t.id,
        file: loc ? loc.file : (t.resolved ? "(resolved)" : "(unlocated)"),
        fragment: loc?.fragment || "", context: loc?.context || "",
        position: loc && Number.isFinite(loc.pos) ? loc.pos : "",
        resolved: t.resolved, resolvedAt: t.resolvedAt, messages: t.messages,
      });
    }
  } else {
    for (const grp of fileGroups)
      for (const a of grp.entries)
        records.push({
          threadId: "", file: grp.file, fragment: a.fragment, context: a.context,
          position: Number.isFinite(a.pos) ? a.pos : "", resolved: false, resolvedAt: "",
          messages: a.notes.map((n) => ({ content: n.body, author: n.author, timestamp: n.time })),
        });
  }
  if (!records.length) return {
    ok: false,
    error: panelOpen
      ? "No comments found in this project."
      : "Couldn't open the Review panel automatically. Open it (the Review toggle in the editor) and try again.",
  };

  // ---- 4. group by file ----------------------------------------------------
  const order = [...fileGroups.map((g) => g.file), "(resolved)", "(unlocated)"];
  const byFile = new Map();
  for (const r of records) { if (!byFile.has(r.file)) byFile.set(r.file, []); byFile.get(r.file).push(r); }
  for (const list of byFile.values())
    list.sort((a, b) => (a.position === "" ? Infinity : a.position) - (b.position === "" ? Infinity : b.position));
  const fileNames = order.filter((f) => byFile.has(f));
  const perFile = fileNames.map((f) => ({ file: f, count: byFile.get(f).length }));

  // ---- 5. format & download ------------------------------------------------
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${CFG.prefix}_${safeName(projectName)}_${stamp}`;

  function buildMd() {
    const md = [];
    md.push(`# Overleaf comments — ${projectName}`, "");
    md.push(`Generated: ${new Date().toLocaleString()}`);
    md.push(`Files scanned: ${fileGroups.length} · Total comments: ${records.length}`, "");
    md.push(`## Comments per file`, "");
    perFile.forEach((p) => md.push(`- ${p.file} — **${p.count}**`));
    md.push("");
    let n = 0;
    for (const file of fileNames) {
      md.push(`## ${file}  (${byFile.get(file).length})`, "");
      byFile.get(file).forEach((r) => {
        n++;
        md.push(`### ${n}.${r.resolved ? " (resolved)" : ""}`);
        if (r.fragment) {
          md.push("", "**Commented text**", "", "```tex", r.fragment, "```");
          if (r.context && r.context !== r.fragment) md.push("", "**Context**", "", "```tex", r.context, "```");
        } else { md.push("", "_(highlighted text not captured)_"); }
        md.push("", "**Comments**");
        r.messages.forEach((m) => {
          const head = [m.author, m.timestamp].filter(Boolean).join(" · ");
          md.push(`- ${head ? `**${head}:** ` : ""}${norm(m.content)}`);
        });
        if (r.resolved && r.resolvedAt) md.push("", `_Resolved ${r.resolvedAt}_`);
        md.push("");
      });
    }
    return md.join("\n");
  }
  function buildCsv() {
    const cell = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const rows = [["file","thread_id","resolved","position","fragment","context","author","timestamp","comment"].join(",")];
    for (const file of fileNames)
      byFile.get(file).forEach((r) => r.messages.forEach((m) =>
        rows.push([r.file, r.threadId, r.resolved, r.position, r.fragment, r.context, m.author, m.timestamp, norm(m.content)].map(cell).join(","))));
    return rows.join("\n");
  }
  function buildJson() {
    return JSON.stringify({
      project: projectName, projectId, generated: new Date().toISOString(),
      filesScanned: fileGroups.length, totalComments: records.length, perFile, records,
    }, null, 2);
  }
  function download(name, text, mime) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  P({ phase: "downloading", overall: 0.98 });
  const made = [];
  if (CFG.formats.md)   { download(`${base}.md`,   buildMd(),   "text/markdown");  made.push("md"); }
  if (CFG.formats.csv)  { download(`${base}.csv`,  buildCsv(),  "text/csv");       made.push("csv"); }
  if (CFG.formats.json) { download(`${base}.json`, buildJson(), "application/json"); made.push("json"); }

  P({ phase: "done", overall: 1, done: true });
  return {
    ok: true, projectName, filesScanned: fileGroups.length,
    totalComments: records.length, perFile, formats: made, fellBack, panelOpen,
  };
}

// ===========================================================================
// Popup controller (runs in the popup, can use chrome.*)
// ===========================================================================
const statusEl = document.getElementById("status");
const optionsEl = document.getElementById("options");
const runEl = document.getElementById("run");
const resultEl = document.getElementById("result");

const isOverleafProject = (url) =>
  /^https:\/\/([a-z0-9-]+\.)*overleaf\.com\/project\/[0-9a-f]{24}/i.test(url || "");

let activeTab = null;

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  if (!tab || !isOverleafProject(tab.url)) {
    statusEl.textContent = "Open an Overleaf project tab, then click this button again.";
    statusEl.className = "status bad";
    return;
  }
  statusEl.textContent = "Ready. I'll try to open the Review panel for you.";
  statusEl.className = "status ok";
  optionsEl.disabled = false;
  runEl.disabled = false;
}

function readOptions() {
  const scope = document.querySelector('input[name="scope"]:checked').value;
  return {
    scope,
    formats: {
      md: document.getElementById("fmt-md").checked,
      csv: document.getElementById("fmt-csv").checked,
      json: document.getElementById("fmt-json").checked,
    },
  };
}

function renderResult(r) {
  resultEl.hidden = false;
  if (!r || !r.ok) {
    resultEl.className = "result bad";
    resultEl.textContent = (r && r.error) || "Something went wrong.";
    return;
  }
  resultEl.className = "result";
  const rows = r.perFile.map((p) => `<tr><td>${escapeHtml(p.file)}</td><td>${p.count}</td></tr>`).join("");
  resultEl.innerHTML =
    `<h2>Done — ${r.totalComments} comment(s)</h2>` +
    (r.fellBack ? `<p class="note">Couldn't read the file tree; exported the open file only.</p>` : "") +
    (r.panelOpen === false ? `<p class="note">Review panel wasn't open, so highlighted-text snippets may be missing. Open it and re-run for those.</p>` : "") +
    `<table>${rows}<tr class="total"><td>Total</td><td>${r.totalComments}</td></tr></table>` +
    `<p class="note">Downloaded: ${r.formats.join(", ") || "nothing (no format selected)"}.</p>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- live progress -------------------------------------------------------
const progressEl = document.getElementById("progress");
const phaseEl = document.getElementById("phase");
const overallFill = document.getElementById("overall-fill");
const overallPct = document.getElementById("overall-pct");
const overallSub = document.getElementById("overall-sub");
const fileFill = document.getElementById("file-fill");
const filePct = document.getElementById("file-pct");
const fileName = document.getElementById("file-name");

const PHASE_LABEL = {
  reading: "Reading comments", scanning: "Scanning files",
  formatting: "Formatting", downloading: "Downloading", done: "Done",
};

function renderProgress(p) {
  if (!p) return;
  progressEl.hidden = false;
  phaseEl.textContent = PHASE_LABEL[p.phase] || "Working";
  const o = Math.max(0, Math.min(1, p.overall || 0));
  overallFill.style.width = `${(o * 100).toFixed(1)}%`;
  overallPct.textContent = `${Math.round(o * 100)}%`;
  overallSub.textContent = p.fileTotal
    ? `File ${Math.min(p.fileIndex, p.fileTotal)} of ${p.fileTotal}` : "";
  const f = Math.max(0, Math.min(1, p.fileProgress || 0));
  fileFill.style.width = `${(f * 100).toFixed(1)}%`;
  filePct.textContent = `${Math.round(f * 100)}%`;
  fileName.textContent = p.fileName || "";
  progressEl.classList.toggle("complete", !!p.done);
}

let pollTimer = null;
function startPolling() {
  progressEl.hidden = false;
  progressEl.classList.remove("complete");
  renderProgress({ phase: "reading", overall: 0.03, fileName: "Starting…" });
  pollTimer = setInterval(async () => {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id }, world: "MAIN",
        func: () => window.__olceProgress || null,
      });
      if (r?.result) renderProgress(r.result);
    } catch { /* tab busy mid-navigation; ignore this tick */ }
  }, 250);
}
function stopPolling(finalOk) {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (finalOk) renderProgress({ phase: "done", overall: 1, fileProgress: 1, done: true });
}

runEl.addEventListener("click", async () => {
  const opts = readOptions();
  if (!opts.formats.md && !opts.formats.csv && !opts.formats.json) {
    statusEl.textContent = "Pick at least one format.";
    statusEl.className = "status bad";
    return;
  }
  runEl.disabled = true;
  runEl.classList.add("busy");
  runEl.textContent = opts.scope === "all" ? "Scanning all files…" : "Scanning…";
  statusEl.textContent = "Working — keep this Overleaf tab in front.";
  statusEl.className = "status";
  resultEl.hidden = true;
  startPolling();

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      world: "MAIN",
      func: olceScan,
      args: [opts],
    });
    stopPolling(res?.result?.ok);
    renderResult(res?.result);
    statusEl.textContent = "Finished.";
    statusEl.className = "status ok";
  } catch (e) {
    stopPolling(false);
    renderResult({ ok: false, error: String(e?.message || e) });
    statusEl.textContent = "Error.";
    statusEl.className = "status bad";
  } finally {
    runEl.disabled = false;
    runEl.classList.remove("busy");
    runEl.textContent = "Scan & export";
  }
});

init();
