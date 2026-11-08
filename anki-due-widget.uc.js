// ==UserScript==
// @name           anki-widget
// @include        main
// ==/UserScript==
//
// Anki due-cards widget for the Zen sidebar.
// NOTE: keep this file pure ASCII. The loader reads it as Latin-1, so any
// raw UTF-8 symbol shows up as garbage. Use \uXXXX escapes in strings.
//
// v1.0.0
//  - First version. Shows how many cards are due (review + learning) and how
//    many new cards are available today, read from AnkiWeb, so desktop Anki
//    does not have to be running. Numbers are as fresh as your last sync.
//  - Same glass look, mounting and boot logic as the SoundCloud widget.

(() => {
  "use strict";

  const ANKI_WIDGET_VERSION = "1.0.0";
  const ENDPOINT = "https://ankiweb.net/svc/decks/deck-list-info";
  const DECKS_PAGE = "https://ankiweb.net/decks";

  // ---- minimal protobuf reader (AnkiWeb answers with protobuf, not JSON) ----
  function readVarint(buf, pos) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      if (pos >= buf.length) throw new Error("truncated varint");
      byte = buf[pos++];
      result += (byte & 0x7f) * 2 ** shift; // safe for ids up to 2^53
      shift += 7;
    } while (byte & 0x80);
    return [result, pos];
  }

  function* fields(buf) {
    let pos = 0;
    while (pos < buf.length) {
      let tag;
      [tag, pos] = readVarint(buf, pos);
      const field = Math.floor(tag / 8);
      const wire = tag % 8;
      let value;
      if (wire === 0) {
        [value, pos] = readVarint(buf, pos);
      } else if (wire === 2) {
        let len;
        [len, pos] = readVarint(buf, pos);
        if (pos + len > buf.length) throw new Error("truncated field");
        value = buf.subarray(pos, pos + len);
        pos += len;
      } else if (wire === 1) {
        value = buf.subarray(pos, pos + 8);
        pos += 8;
      } else if (wire === 5) {
        value = buf.subarray(pos, pos + 4);
        pos += 4;
      } else {
        throw new Error("unsupported wire type " + wire);
      }
      yield { field, wire, value };
    }
  }

  // Layout, decoded from a real AnkiWeb reply:
  //   message { field 1 = root { field 3 (repeated) = top-level deck } }
  //   deck: 2 = name, 6 = review count, 7 = learn count, 8 = new count,
  //         3 (repeated) = sub-decks. A deck's counts already include its
  //         sub-decks, so only top-level decks are summed.
  // AnkiWeb's "due" column is review + learn.
  function parseDeckList(bytes) {
    let root = null;
    for (const f of fields(bytes)) {
      if (f.field === 1 && f.wire === 2) {
        root = f.value;
        break;
      }
    }
    if (!root) throw new Error("unexpected response format");

    const decks = [];
    for (const f of fields(root)) {
      if (f.field !== 3 || f.wire !== 2) continue;
      const deck = { name: "", due: 0, fresh: 0 };
      let review = 0;
      let learn = 0;
      for (const g of fields(f.value)) {
        if (g.field === 2 && g.wire === 2) deck.name = new TextDecoder().decode(g.value);
        else if (g.field === 6 && g.wire === 0) review = g.value;
        else if (g.field === 7 && g.wire === 0) learn = g.value;
        else if (g.field === 8 && g.wire === 0) deck.fresh = g.value;
      }
      deck.due = review + learn;
      decks.push(deck);
    }
    return decks;
  }
  // ---- end protobuf reader ----

  // =====================================================================
  // CHROME SIDE (the widget itself)
  // =====================================================================
  function ankiWidgetInit() {
    if (document.getElementById("anki-widget")) return;
    console.log("[ANKI-WIDGET] init v" + ANKI_WIDGET_VERSION);

    // ---- Palette (same neutral glass/mica palette as the SoundCloud widget) ----
    const COL_TEXT = "#f4f4f5";
    const COL_SELECTION = "rgba(255, 255, 255, 0.14)";
    const COL_SURFACE_SOFT = "rgba(255, 255, 255, 0.05)";
    const COL_TEXT_DIM = "rgba(255, 255, 255, 0.74)";
    const COL_TEXT_FAINT = "rgba(255, 255, 255, 0.50)";
    const SVG_NS = "http://www.w3.org/2000/svg";

    // =================== SETTINGS (about:config "anki-widget.*") ===================
    const PREFIX = "anki-widget.";
    function getInt(n, d) {
      try { return Services.prefs.getIntPref(PREFIX + n, d); } catch (e) { return d; }
    }
    const REFRESH_MS = Math.max(1, getInt("refresh-minutes", 10)) * 60 * 1000;
    const STALE_MS = 2 * 60 * 1000;      // refresh on focus if older than this
    const RETRY_MS = 10 * 1000;          // ...or this, while logged out / failing

    // =================== DOM ===================
    const widgetDiv = document.createElement("div");
    widgetDiv.id = "anki-widget";
    widgetDiv.dataset.state = "loading";

    const styleTag = document.createElement("style");
    styleTag.textContent = `
      #anki-widget {
        position: relative; display: flex; align-items: center; gap: 10px;
        flex-shrink: 0; min-width: 0; max-width: calc(100% - 16px);
        contain: inline-size; overflow: hidden;
        margin: 6px 8px 8px; padding: 8px 12px; box-sizing: border-box;
        -moz-window-dragging: no-drag; cursor: pointer;
        background: transparent;
        backdrop-filter: blur(14px) saturate(160%);
        border: none; border-radius: 16px;
        box-shadow: 0 12px 32px -10px rgba(0, 0, 0, 0.28);
        transition: opacity 0.12s ease;
        font-family: system-ui, -apple-system, sans-serif; color: ${COL_TEXT}; font-size: 11px;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.42);
        animation: anki-in 0.25s ease backwards;
      }
      @keyframes anki-in { from { opacity: 0; transform: translateY(4px); } }
      /* Glass rim: one flat, faint 1px ring, identical all the way round. */
      #anki-widget::before {
        content: ""; position: absolute; inset: 0; padding: 1px; box-sizing: border-box;
        border-radius: inherit; pointer-events: none;
        background: rgba(255, 255, 255, 0.10);
        mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
        mask-composite: exclude;
      }
      #anki-widget *::selection { background-color: ${COL_SELECTION}; color: ${COL_TEXT}; }
      #anki-widget:hover { background-color: ${COL_SURFACE_SOFT}; }
      #anki-widget.anki-narrow { display: none !important; }

      #anki-widget .anki-num {
        font-size: 22px; line-height: 1; font-weight: 600;
        font-variant-numeric: tabular-nums; flex-shrink: 0;
      }
      #anki-widget[data-state="done"] .anki-num { opacity: 0.6; }
      #anki-widget[data-stale="1"] .anki-num,
      #anki-widget[data-stale="1"] .anki-text { opacity: 0.55; }
      #anki-widget .anki-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
      #anki-widget .anki-label { color: ${COL_TEXT_DIM}; }
      #anki-widget .anki-sub { color: ${COL_TEXT_FAINT}; }
      #anki-widget .anki-label,
      #anki-widget .anki-sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
      #anki-widget .anki-sub:empty { display: none; }

      #anki-widget .anki-refresh {
        appearance: none; border: none; margin: 0; padding: 0;
        font: inherit; color: inherit; cursor: pointer; -moz-window-dragging: no-drag;
        display: flex; align-items: center; justify-content: center;
        width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0;
        background-color: ${COL_SURFACE_SOFT}; opacity: 0.4;
        transition: background-color 0.12s ease, transform 0.08s ease, opacity 0.15s ease;
      }
      #anki-widget:hover .anki-refresh { opacity: 1; }
      #anki-widget .anki-refresh:hover { background-color: ${COL_SELECTION}; }
      #anki-widget .anki-refresh:active { transform: scale(0.94); }
      #anki-widget.anki-loading .anki-refresh svg { animation: anki-spin 0.9s linear infinite; }
      @keyframes anki-spin { to { transform: rotate(360deg); } }
    `;
    widgetDiv.appendChild(styleTag);

    function el(tag, cls, text) {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }

    const numEl = el("div", "anki-num", "\u2026");
    const textEl = el("div", "anki-text");
    const labelEl = el("div", "anki-label", "due");
    const subEl = el("div", "anki-sub");
    textEl.appendChild(labelEl);
    textEl.appendChild(subEl);

    // Lucide "rotate-cw"
    const refreshBtn = el("button", "anki-refresh");
    refreshBtn.title = "Refresh";
    (function () {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("width", "12");
      svg.setAttribute("height", "12");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", COL_TEXT);
      svg.setAttribute("stroke-width", "2");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      for (const d of ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"]) {
        const p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("d", d);
        svg.appendChild(p);
      }
      refreshBtn.appendChild(svg);
    })();

    widgetDiv.appendChild(numEl);
    widgetDiv.appendChild(textEl);
    widgetDiv.appendChild(refreshBtn);

    // =================== DATA ===================
    async function loadCounts() {
      const res = await fetch(ENDPOINT, { method: "POST", credentials: "include", cache: "no-store" });
      if (res.status === 401 || res.status === 403) return { state: "login" };
      if ((res.headers.get("content-type") || "").includes("text/html")) return { state: "login" };
      if (!res.ok) throw new Error("HTTP " + res.status);
      const decks = parseDeckList(new Uint8Array(await res.arrayBuffer()));
      return {
        state: "ok",
        decks,
        due: decks.reduce((n, d) => n + d.due, 0),
        fresh: decks.reduce((n, d) => n + d.fresh, 0),
      };
    }

    // =================== RENDER ===================
    let lastGood = null;

    function render(r, stale) {
      widgetDiv.dataset.stale = stale ? "1" : "";
      if (r.state === "ok") {
        widgetDiv.dataset.state = r.due === 0 ? "done" : "ok";
        numEl.textContent = String(r.due);
        labelEl.textContent = "due";
        subEl.textContent = r.fresh ? "+" + r.fresh + " new" : "";
        const lines = r.decks
          .filter((d) => d.due || d.fresh)
          .map((d) => d.name + ": " + d.due + (d.fresh ? " (+" + d.fresh + " new)" : ""));
        widgetDiv.title = ["Due: " + r.due + ", new: " + r.fresh]
          .concat(lines)
          .concat(stale ? ["", "Could not refresh, showing the last values."] : [])
          .join("\n");
      } else if (r.state === "login") {
        widgetDiv.dataset.state = "login";
        numEl.textContent = "!";
        labelEl.textContent = "Log in to AnkiWeb";
        subEl.textContent = "click to open";
        widgetDiv.title = "Log in at ankiweb.net in this browser, then press refresh.";
      } else {
        widgetDiv.dataset.state = "error";
        numEl.textContent = "!";
        labelEl.textContent = "AnkiWeb unreachable";
        subEl.textContent = r.message || "";
        widgetDiv.title = "Could not load data from AnkiWeb. Press refresh to try again.";
      }
    }

    let busy = false;
    let lastRun = 0;
    let lastOk = false;

    async function refresh() {
      if (busy) return;
      busy = true;
      widgetDiv.classList.add("anki-loading");
      try {
        const r = await loadCounts();
        lastOk = r.state === "ok";
        if (lastOk) lastGood = r;
        render(r, false);
      } catch (e) {
        console.log("[ANKI-WIDGET] refresh failed: " + (e && e.message));
        lastOk = false;
        if (lastGood) render(lastGood, true);
        else render({ state: "error", message: String((e && e.message) || e).slice(0, 60) }, false);
      } finally {
        lastRun = Date.now();
        busy = false;
        widgetDiv.classList.remove("anki-loading");
      }
      if (!widgetDiv.isConnected) mountWidget();
    }

    // =================== ACTIONS ===================
    function openAnkiWeb() {
      try {
        for (const tab of gBrowser.tabs) {
          try {
            if (tab.linkedBrowser.currentURI.host === "ankiweb.net") {
              gBrowser.selectedTab = tab;
              return;
            }
          } catch (e) {}
        }
        gBrowser.selectedTab = gBrowser.addTab(DECKS_PAGE, {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
      } catch (e) {
        console.log("[ANKI-WIDGET] open tab failed: " + (e && e.message));
      }
    }

    widgetDiv.addEventListener("click", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest(".anki-refresh")) return;
      openAnkiWeb();
    });
    refreshBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      refresh();
    });

    // =================== MOUNTING (same spot as the SoundCloud widget) ===================
    let resizeObs = null;
    function findMount() {
      for (const id of ["zen-sidebar-foot-buttons", "zen-sidebar-bottom-buttons"]) {
        const node = document.getElementById(id);
        if (node && node.parentNode) {
          let parent = node.parentNode;
          let before = node;
          try {
            const cs = getComputedStyle(parent);
            if (cs.display.includes("flex") && cs.flexDirection.startsWith("row") && parent.parentNode) {
              before = parent;
              parent = parent.parentNode;
            }
          } catch (e) {}
          return { parent, before };
        }
      }
      const tabs = document.getElementById("tabbrowser-tabs");
      if (tabs && tabs.parentNode) return { parent: tabs.parentNode, before: tabs.nextSibling };
      return null;
    }

    function mountWidget() {
      const m = findMount();
      if (!m) return false;
      if (widgetDiv.parentNode !== m.parent || widgetDiv.nextSibling !== m.before) {
        m.parent.insertBefore(widgetDiv, m.before);
        console.log("[ANKI-WIDGET] mounted into", m.parent.id || m.parent.tagName);
      }
      try {
        if (resizeObs) resizeObs.disconnect();
        resizeObs = new ResizeObserver(() => {
          widgetDiv.classList.toggle("anki-narrow", m.parent.clientWidth < 150);
        });
        resizeObs.observe(m.parent);
      } catch (e) {}
      return true;
    }

    // =================== WIRE UP ===================
    if (!mountWidget()) {
      let tries = 0;
      const iv = setInterval(() => {
        if (mountWidget() || ++tries > 30) clearInterval(iv);
      }, 500);
    }

    setInterval(() => {
      if (!document.hidden) refresh();
    }, REFRESH_MS);

    // Coming back to the window (e.g. after syncing on the phone): refresh if stale.
    function refreshIfStale() {
      if (document.hidden) return;
      const limit = lastOk ? STALE_MS : RETRY_MS;
      if (Date.now() - lastRun > limit) refresh();
    }
    document.addEventListener("visibilitychange", refreshIfStale);
    window.addEventListener("focus", refreshIfStale);

    refresh();

    // Don't draw over the urlbar results panel
    try {
      const urlbarPanel = window.gURLBar && window.gURLBar.view && window.gURLBar.view.panel;
      if (urlbarPanel) {
        urlbarPanel.addEventListener("popupshowing", () => {
          widgetDiv.style.opacity = "0";
          widgetDiv.style.pointerEvents = "none";
        });
        urlbarPanel.addEventListener("popuphidden", () => {
          widgetDiv.style.opacity = "1";
          widgetDiv.style.pointerEvents = "";
        });
      }
    } catch (e) {}
  }

  // ---- Boot ----
  try {
    if (typeof UC_API !== "undefined" && UC_API && UC_API.Runtime && UC_API.Runtime.startupFinished) {
      UC_API.Runtime.startupFinished().then(ankiWidgetInit);
    } else if (document.readyState === "complete") {
      ankiWidgetInit();
    } else {
      window.addEventListener("load", ankiWidgetInit, { once: true });
    }
  } catch (e) {
    console.log("[ANKI-WIDGET] top-level error while triggering init: " + (e && e.message));
  }
})();