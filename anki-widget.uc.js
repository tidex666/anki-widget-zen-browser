// ==UserScript==
// @name           anki-widget
// @include        main
// ==/UserScript==
//
// Anki due-cards widget for the Zen sidebar.
// NOTE: keep this file pure ASCII. The loader reads it as Latin-1, so any
// raw UTF-8 symbol shows up as garbage. Use \uXXXX escapes in strings.
//
// v1.3.1
//  - Widget has a fixed minimum height (46px) in every state, so the stacked
//    gear/refresh buttons that appear on hover have room above and below
//    them instead of almost touching the edge. They also sit exactly where
//    the flashcard glyph is, so the two swap in place.
// v1.3.0
//  - Small flashcard glyph (a card with an "A") at the right edge; on hover it
//    swaps places with the gear/refresh buttons. It is an original drawing,
//    not the official Anki logo.
//  - When there is no "+N new" line, the label now sits on the baseline of the
//    number ("102 due") instead of floating in the middle of an empty box.
//  - Shorter texts for the login / error states so they are not cut off.
// v1.2.0
//  - Settings (gear button, shown on hover): pick which decks count towards
//    the due / new numbers. Unticked decks (and everything below them) are
//    left out. Nothing is changed in Anki itself. The choice is stored in
//    about:config "anki-widget.excluded" and shared between windows.
//  - Explicit window-state check: no AnkiWeb requests while the browser
//    window is minimised or hidden; it refreshes again as soon as it is back.
// v1.1.0
//  - Hover: the tint and the brighter rim now live on pseudo-elements that
//    inherit the radius, so the corners stay clean (changing the background
//    of the blurred root itself left ugly corners).
//  - Refresh button is hidden until hover and floats over the right edge
//    instead of taking space, so the text ("+48 new") is no longer cut off.
//  - Zero due and no new cards shows "all done"; tooltip shows last update.
//  - Always mounts ABOVE the SoundCloud widget, whatever loads first.
// v1.0.0
//  - First version. Shows how many cards are due (review + learning) and how
//    many new cards are available today, read from AnkiWeb, so desktop Anki
//    does not have to be running. Numbers are as fresh as your last sync.
//  - Same glass look, mounting and boot logic as the SoundCloud widget.

(() => {
  "use strict";

  const ANKI_WIDGET_VERSION = "1.3.1";
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
  //         sub-decks. AnkiWeb's "due" column is review + learn.
  // Decks are parsed into a tree; `path` is the full "Parent::Child" name
  // and is what the deck selection in the settings is keyed on.
  function parseDeck(bytes, parentPath) {
    const deck = { name: "", path: "", due: 0, fresh: 0, children: [] };
    let review = 0;
    let learn = 0;
    const subs = [];
    for (const g of fields(bytes)) {
      if (g.field === 2 && g.wire === 2) deck.name = new TextDecoder().decode(g.value);
      else if (g.field === 6 && g.wire === 0) review = g.value;
      else if (g.field === 7 && g.wire === 0) learn = g.value;
      else if (g.field === 8 && g.wire === 0) deck.fresh = g.value;
      else if (g.field === 3 && g.wire === 2) subs.push(g.value);
    }
    deck.due = review + learn;
    // sub-deck names may come as the leaf only or as the full path
    deck.path = parentPath && deck.name.indexOf(parentPath + "::") !== 0
      ? parentPath + "::" + deck.name
      : deck.name;
    for (const sub of subs) deck.children.push(parseDeck(sub, deck.path));
    return deck;
  }

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
      if (f.field === 3 && f.wire === 2) decks.push(parseDeck(f.value, ""));
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
    const COL_BG = "#18181b";
    const COL_TEXT = "#f4f4f5";
    const COL_SELECTION = "rgba(255, 255, 255, 0.14)";
    const COL_SURFACE = "rgba(255, 255, 255, 0.08)";
    const COL_SURFACE_SOFT = "rgba(255, 255, 255, 0.05)";
    const COL_TEXT_DIM = "rgba(255, 255, 255, 0.74)";
    const COL_TEXT_FAINT = "rgba(255, 255, 255, 0.50)";
    const SVG_NS = "http://www.w3.org/2000/svg";

    // =================== SETTINGS (about:config "anki-widget.*") ===================
    const PREFIX = "anki-widget.";
    function getInt(n, d) {
      try { return Services.prefs.getIntPref(PREFIX + n, d); } catch (e) { return d; }
    }
    function getStr(n, d) {
      try { return Services.prefs.getStringPref(PREFIX + n, d); } catch (e) { return d; }
    }
    function setStr(n, v) {
      try { Services.prefs.setStringPref(PREFIX + n, v); } catch (e) {}
    }
    const REFRESH_MS = Math.max(1, getInt("refresh-minutes", 10)) * 60 * 1000;
    const STALE_MS = 2 * 60 * 1000;      // refresh on focus if older than this
    const RETRY_MS = 10 * 1000;          // ...or this, while logged out / failing

    // Decks the user turned off (full paths). New decks are counted by default.
    const excluded = new Set();
    function loadExcluded() {
      excluded.clear();
      try {
        const a = JSON.parse(getStr("excluded", "[]"));
        if (Array.isArray(a)) for (const x of a) if (typeof x === "string") excluded.add(x);
      } catch (e) {}
    }
    function saveExcluded() {
      setStr("excluded", JSON.stringify(Array.from(excluded)));
    }
    loadExcluded();

    // A deck's counts include its sub-decks, so for a deck that stays on but
    // has switched-off sub-decks, their share is subtracted. (If Anki's daily
    // limits cap the parent, this is an approximation.)
    function effective(deck) {
      if (excluded.has(deck.path)) return { due: 0, fresh: 0 };
      let due = deck.due;
      let fresh = deck.fresh;
      for (const c of deck.children) {
        const e = effective(c);
        due -= c.due - e.due;
        fresh -= c.fresh - e.fresh;
      }
      return { due: Math.max(0, due), fresh: Math.max(0, fresh) };
    }
    function totals(decks) {
      let due = 0;
      let fresh = 0;
      for (const d of decks) {
        const e = effective(d);
        due += e.due;
        fresh += e.fresh;
      }
      return { due, fresh };
    }
    function flatten(decks, out) {
      for (const d of decks) {
        out.push(d);
        flatten(d.children, out);
      }
      return out;
    }

    // Minimised (or otherwise hidden) window: nothing is drawn, so no requests.
    function windowHidden() {
      try {
        if (window.windowState === window.STATE_MINIMIZED) return true;
      } catch (e) {}
      return !!document.hidden;
    }

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
        margin: 6px 8px 8px; padding: 8px 12px; box-sizing: border-box; min-height: 46px;
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
      /* Hover = a soft tint layer behind the content + a brighter rim. Both are
         pseudo-elements with inherited radius, so the corners stay clean. */
      #anki-widget::after {
        content: ""; position: absolute; inset: 0; border-radius: inherit;
        z-index: -1; pointer-events: none;
        background: rgba(255, 255, 255, 0.06);
        opacity: 0; transition: opacity 0.15s ease;
      }
      #anki-widget:hover::after { opacity: 1; }
      #anki-widget::before { transition: background-color 0.15s ease; }
      #anki-widget:hover::before { background: rgba(255, 255, 255, 0.20); }
      #anki-widget.anki-narrow { display: none !important; }
      #anki-widget.anki-settings-open { cursor: default; }

      /* ---- main view ---- */
      #anki-widget.anki-settings-open .anki-num,
      #anki-widget.anki-settings-open .anki-text,
      #anki-widget.anki-settings-open .anki-logo,
      #anki-widget.anki-settings-open .anki-actions { display: none !important; }
      #anki-widget:not(.anki-settings-open) .anki-panel { display: none !important; }

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

      /* No "+N new" line: put the label on the baseline of the number ("102 due"). */
      /* (extra vertical padding keeps the line centred in the 46px minimum height) */
      #anki-widget.anki-single:not(.anki-settings-open) {
        align-items: baseline; padding-top: 12px; padding-bottom: 12px;
      }

      /* flashcard glyph at the right edge; swaps with the buttons on hover */
      #anki-widget .anki-logo {
        display: flex; align-items: center; justify-content: center;
        align-self: center; flex-shrink: 0; width: 18px; height: 18px;
        opacity: 0.55; transition: opacity 0.15s ease; pointer-events: none;
      }
      #anki-widget:hover .anki-logo { opacity: 0; }

      /* round flat buttons (gear, refresh, back) */
      #anki-widget .anki-btn {
        appearance: none; border: none; margin: 0; padding: 0;
        font: inherit; color: inherit; cursor: pointer; -moz-window-dragging: no-drag;
        display: flex; align-items: center; justify-content: center;
        border-radius: 50%; flex-shrink: 0; background-color: ${COL_SURFACE};
        transition: background-color 0.12s ease, transform 0.08s ease;
      }
      #anki-widget .anki-btn:hover { background-color: ${COL_SELECTION}; }
      #anki-widget .anki-btn:active { transform: scale(0.92); }

      /* gear + refresh: stacked at the right edge, only visible on hover */
      #anki-widget .anki-actions {
        position: absolute; right: 13px; top: 50%; transform: translateY(-50%);
        display: flex; flex-direction: column; gap: 2px;
        opacity: 0; pointer-events: none; transition: opacity 0.15s ease;
      }
      #anki-widget:hover .anki-actions { opacity: 1; pointer-events: auto; }
      #anki-widget .anki-actions .anki-btn { width: 16px; height: 16px; }
      #anki-widget.anki-loading .anki-refresh svg { animation: anki-spin 0.9s linear infinite; }
      @keyframes anki-spin { to { transform: rotate(360deg); } }

      /* ---- settings panel ---- */
      #anki-widget .anki-panel { display: flex; flex-direction: column; gap: 6px; flex: 1; width: 100%; min-width: 0; }
      #anki-widget .anki-panel-head {
        display: grid; grid-template-columns: 18px 1fr 18px; align-items: center; gap: 6px;
      }
      #anki-widget .anki-panel-head .anki-btn { width: 18px; height: 18px; }
      #anki-widget .anki-panel-title { text-align: center; font-size: 12px; font-weight: 700; }
      #anki-widget .anki-list {
        display: flex; flex-direction: column; gap: 1px;
        max-height: 190px; overflow-y: auto; overflow-x: hidden;
        margin: 0 -6px; padding: 0 6px;
        scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
      }
      #anki-widget .anki-row {
        display: flex; align-items: center; gap: 7px; min-width: 0;
        padding: 4px 5px; border-radius: 8px; cursor: pointer;
        transition: background-color 0.12s ease;
      }
      #anki-widget .anki-row:hover { background: ${COL_SURFACE}; }
      #anki-widget .anki-row.anki-locked { opacity: 0.45; pointer-events: none; }
      #anki-widget .anki-row-name {
        flex: 1; min-width: 0; font-size: 11px; color: rgba(255, 255, 255, 0.88);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      #anki-widget .anki-row.anki-off .anki-row-name { color: ${COL_TEXT_FAINT}; }
      #anki-widget .anki-row-count {
        flex-shrink: 0; font-size: 10px; color: ${COL_TEXT_FAINT}; font-variant-numeric: tabular-nums;
      }
      #anki-widget .anki-check {
        display: flex; align-items: center; justify-content: center;
        width: 13px; height: 13px; border-radius: 4px; flex-shrink: 0; box-sizing: border-box;
        border: 1.5px solid ${COL_TEXT_FAINT};
        transition: background-color 0.12s ease, border-color 0.12s ease;
      }
      #anki-widget .anki-check svg { opacity: 0; }
      #anki-widget .anki-check.anki-on { background: ${COL_TEXT}; border-color: ${COL_TEXT}; }
      #anki-widget .anki-check.anki-on svg { opacity: 1; }
      #anki-widget .anki-empty {
        padding: 14px 6px; text-align: center; color: ${COL_TEXT_FAINT};
        font-size: 10.5px; line-height: 1.45; white-space: pre-line;
      }
      #anki-widget .anki-foot {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        font-size: 9.5px; color: ${COL_TEXT_FAINT}; min-height: 20px;
      }
      #anki-widget .anki-pill {
        appearance: none; border: none; margin: 0; padding: 0 9px; height: 20px;
        border-radius: 10px; box-sizing: border-box; cursor: pointer; -moz-window-dragging: no-drag;
        font: inherit; font-size: 10px; font-weight: 600; white-space: nowrap;
        background: ${COL_SURFACE}; color: ${COL_TEXT_DIM};
        transition: background-color 0.12s ease, color 0.12s ease;
      }
      #anki-widget .anki-pill:hover { background: ${COL_SELECTION}; color: ${COL_TEXT}; }
    `;
    widgetDiv.appendChild(styleTag);

    function el(tag, cls, text) {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }

    function svgIcon(paths, size, stroke, sw) {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("width", String(size));
      svg.setAttribute("height", String(size));
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", stroke);
      svg.setAttribute("stroke-width", String(sw));
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      for (const d of paths) {
        const p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("d", d);
        svg.appendChild(p);
      }
      svg.style.pointerEvents = "none";
      return svg;
    }

    // Lucide icons
    const PATH_REFRESH = ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"];
    const PATH_BACK = ["M15 6l-6 6 6 6"];
    const PATH_CHECK = ["M5 12l5 5L20 7"];
    // own drawing: a flashcard with an "A", and the edge of the card behind it
    const PATH_LOGO = [
      "M7 3.5h10",
      "M6.5 6.5h11A2.5 2.5 0 0 1 20 9v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18V9a2.5 2.5 0 0 1 2.5-2.5z",
      "M9.3 17.5L12 10l2.7 7.5",
      "M10.2 15h3.6"
    ];
    const PATH_GEAR = [
      "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
      "M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0"
    ];

    // ---- main view ----
    const numEl = el("div", "anki-num", "\u2026");
    const textEl = el("div", "anki-text");
    const labelEl = el("div", "anki-label", "due");
    const subEl = el("div", "anki-sub");
    textEl.appendChild(labelEl);
    textEl.appendChild(subEl);

    const actions = el("div", "anki-actions");
    const gearBtn = el("button", "anki-btn anki-gear");
    gearBtn.title = "Choose decks";
    gearBtn.appendChild(svgIcon(PATH_GEAR, 10, COL_TEXT, 2));
    const refreshBtn = el("button", "anki-btn anki-refresh");
    refreshBtn.title = "Refresh";
    refreshBtn.appendChild(svgIcon(PATH_REFRESH, 10, COL_TEXT, 2));
    actions.appendChild(gearBtn);
    actions.appendChild(refreshBtn);

    const logoEl = el("div", "anki-logo");
    logoEl.appendChild(svgIcon(PATH_LOGO, 18, COL_TEXT, 1.6));

    widgetDiv.appendChild(numEl);
    widgetDiv.appendChild(textEl);
    widgetDiv.appendChild(logoEl);
    widgetDiv.appendChild(actions);

    // ---- settings panel (deck selection) ----
    const panel = el("div", "anki-panel");
    panel.id = "anki-settings";
    const head = el("div", "anki-panel-head");
    const backBtn = el("button", "anki-btn");
    backBtn.title = "Back";
    backBtn.appendChild(svgIcon(PATH_BACK, 10, COL_TEXT, 3));
    head.appendChild(backBtn);
    head.appendChild(el("div", "anki-panel-title", "Decks"));
    head.appendChild(el("div"));
    const listEl = el("div", "anki-list");
    const foot = el("div", "anki-foot");
    const footCount = el("span");
    const showAllBtn = el("button", "anki-pill", "Show all");
    foot.appendChild(footCount);
    foot.appendChild(showAllBtn);
    panel.appendChild(head);
    panel.appendChild(listEl);
    panel.appendChild(foot);
    widgetDiv.appendChild(panel);

    // =================== DATA ===================
    async function loadCounts() {
      const res = await fetch(ENDPOINT, { method: "POST", credentials: "include", cache: "no-store" });
      if (res.status === 401 || res.status === 403) return { state: "login" };
      if ((res.headers.get("content-type") || "").includes("text/html")) return { state: "login" };
      if (!res.ok) throw new Error("HTTP " + res.status);
      const decks = parseDeckList(new Uint8Array(await res.arrayBuffer()));
      return { state: "ok", at: Date.now(), decks };
    }

    // =================== RENDER ===================
    let lastGood = null;
    let shown = null;
    let shownStale = false;

    function render(r, stale) {
      shown = r;
      shownStale = !!stale;
      widgetDiv.dataset.stale = stale ? "1" : "";
      if (r.state === "ok") {
        const t = totals(r.decks);
        widgetDiv.dataset.state = t.due === 0 ? "done" : "ok";
        numEl.textContent = String(t.due);
        labelEl.textContent = "due";
        subEl.textContent = t.fresh ? "+" + t.fresh + " new" : (t.due === 0 ? "all done" : "");
        widgetDiv.classList.toggle("anki-single", !subEl.textContent);
        const lines = r.decks
          .map((d) => ({ name: d.name, e: effective(d) }))
          .filter((x) => x.e.due || x.e.fresh)
          .map((x) => x.name + ": " + x.e.due + (x.e.fresh ? " (+" + x.e.fresh + " new)" : ""));
        const hidden = flatten(r.decks, []).filter((d) => excluded.has(d.path)).length;
        let when = "";
        try { when = new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch (e) {}
        widgetDiv.title = ["Due: " + t.due + ", new: " + t.fresh + (when ? " (updated " + when + ")" : "")]
          .concat(hidden ? ["Hidden decks: " + hidden] : [])
          .concat(lines)
          .concat(stale ? ["", "Could not refresh, showing the last values."] : [])
          .join("\n");
      } else if (r.state === "login") {
        widgetDiv.dataset.state = "login";
        numEl.textContent = "!";
        labelEl.textContent = "Log in";
        subEl.textContent = "click to open";
        widgetDiv.classList.remove("anki-single");
        widgetDiv.title = "Log in at ankiweb.net in this browser, then press refresh.";
      } else {
        widgetDiv.dataset.state = "error";
        numEl.textContent = "!";
        labelEl.textContent = "Unreachable";
        subEl.textContent = "press refresh";
        widgetDiv.classList.remove("anki-single");
        widgetDiv.title = "Could not load data from AnkiWeb" + (r.message ? " (" + r.message + ")" : "") +
          ". Press refresh to try again.";
      }
    }

    // ---- settings panel rendering ----
    function buildRow(d, depth, off, locked) {
      const row = el("div", "anki-row");
      if (off || locked) row.classList.add("anki-off");
      if (locked) row.classList.add("anki-locked");
      row.style.paddingLeft = (5 + depth * 10) + "px";
      const chk = el("span", "anki-check");
      if (!off && !locked) chk.classList.add("anki-on");
      chk.appendChild(svgIcon(PATH_CHECK, 9, COL_BG, 3.5));
      const leaf = (d.path || d.name || "(unnamed)").split("::").pop();
      const name = el("span", "anki-row-name", leaf);
      row.title = d.path || leaf;
      row.appendChild(chk);
      row.appendChild(name);
      row.appendChild(el("span", "anki-row-count", String(d.due)));
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleDeck(d.path);
      });
      return row;
    }

    function addRows(decks, depth, locked) {
      for (const d of decks) {
        const off = excluded.has(d.path);
        listEl.appendChild(buildRow(d, depth, off, locked));
        addRows(d.children, depth + 1, locked || off);
      }
    }

    function renderSettings() {
      if (!widgetDiv.classList.contains("anki-settings-open")) return;
      const decks = lastGood ? lastGood.decks : [];
      const scroll = listEl.scrollTop;
      listEl.textContent = "";
      if (!decks.length) {
        listEl.appendChild(el("div", "anki-empty", "No decks yet.\nLog in to AnkiWeb and press refresh."));
      } else {
        addRows(decks, 0, false);
      }
      listEl.scrollTop = scroll;
      const hidden = flatten(decks, []).filter((d) => excluded.has(d.path)).length;
      footCount.textContent = hidden ? hidden + " hidden" : "All decks counted";
      showAllBtn.style.display = hidden ? "" : "none";
    }

    function rerender() {
      if (shown && shown.state === "ok") render(shown, shownStale);
      renderSettings();
    }

    function toggleDeck(path) {
      if (excluded.has(path)) excluded.delete(path);
      else excluded.add(path);
      saveExcluded();
      rerender();
    }

    function setSettingsOpen(open) {
      widgetDiv.classList.toggle("anki-settings-open", open);
      if (open) renderSettings();
    }

    // =================== REFRESH ===================
    let busy = false;
    let lastRun = 0;
    let lastOk = false;

    // manual = the person pressed the button: runs even if the window looks hidden
    async function refresh(manual) {
      if (busy || (!manual && windowHidden())) return;
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
      renderSettings();
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
      if (widgetDiv.classList.contains("anki-settings-open")) return;
      if (e.target.closest && e.target.closest(".anki-actions")) return;
      openAnkiWeb();
    });
    refreshBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      refresh(true);
    });
    gearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setSettingsOpen(true);
    });
    backBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setSettingsOpen(false);
    });
    showAllBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      excluded.clear();
      saveExcluded();
      rerender();
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
      // Always sit ABOVE the SoundCloud widget (if it is in the same container),
      // no matter which script loaded first.
      const sc = document.getElementById("sc-widget-test");
      if (sc && sc.parentNode === m.parent) m.before = sc;
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

    // refresh() itself skips automatic runs while the window is minimised/hidden
    setInterval(() => refresh(false), REFRESH_MS);

    // Coming back to the window (restored from minimised, or after syncing on
    // the phone): refresh if the numbers are stale.
    function refreshIfStale() {
      if (windowHidden()) return;
      const limit = lastOk ? STALE_MS : RETRY_MS;
      if (Date.now() - lastRun > limit) refresh(false);
    }
    document.addEventListener("visibilitychange", refreshIfStale);
    window.addEventListener("focus", refreshIfStale);
    window.addEventListener("sizemodechange", refreshIfStale);

    // Keep several windows in sync when the deck selection changes.
    const prefObserver = {
      observe() {
        loadExcluded();
        rerender();
      }
    };
    try {
      Services.prefs.addObserver(PREFIX + "excluded", prefObserver);
      window.addEventListener("unload", () => {
        try { Services.prefs.removeObserver(PREFIX + "excluded", prefObserver); } catch (e) {}
      }, { once: true });
    } catch (e) {}

    refresh(false);

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