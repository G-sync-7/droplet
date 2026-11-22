// Droplet: a rough water estimate for Claude chats (content script).
//
// Runs only on claude.ai. It measures how much text is on the page
// (characters, converted to tokens), turns tokens into energy and energy
// into water, then animates a drop falling into a small glass. Hovering
// over the glass shows where that water went.
// Nothing leaves the browser: no network requests, everything is stored
// locally with chrome.storage.

(() => {
  'use strict';
  if (window.__dropletLoaded) return;
  window.__dropletLoaded = true;

  /* ------------------------------------------------------------------ *
   * 1. Estimation constants. Sources and caveats are in README.md.
   * ------------------------------------------------------------------ */
  const CHARS_PER_TOKEN = 4;            // rough average for English text
  const WH_PER_1K_OUTPUT_TOKENS = 2.8;  // writing (Projet Celsius, large model)
  const WH_PER_1K_INPUT_TOKENS = 0.9;   // reading new text (Projet Celsius, large model)
  const CACHED_READ_SHARE = 0.1;        // re-reading earlier messages is mostly cached: assume 10% of the reading cost
  const MODEL_SCALE = { large: 1, medium: 0.5, small: 0.1 };
  const REASONING_FACTOR = { none: 1, some: 1.92, extended: 10 };
  // Data-centre cooling water per Wh. Claude runs at Amazon, Google and Microsoft:
  // low = Microsoft (0.30 L/kWh), high = Google (1.15 L/kWh), mid = a blend.
  const COOLING_ML_PER_WH = { low: 0.3, mid: 0.6, high: 1.15 };
  const POWER_PLANT_ML_PER_WH = 4.5;    // water used to generate US electricity (LBNL)
  const V1_ML_PER_WH = 1.15;            // v0.1 stored mL at this rate; used to migrate totals
  const GLASS_ML = 250;
  const FALLBACK_PROMPT_CHARS = 400;    // used when user messages can't be found

  /* ------------------------------------------------------------------ *
   * 2. Page selectors. claude.ai changes its markup from time to time;
   *    if replies stop being counted, these are what to update.
   *    Each list is tried in order and the first one that matches wins.
   * ------------------------------------------------------------------ */
  const SELECTORS = {
    assistant: [
      '[data-is-streaming]',
      '.font-claude-response',
      '.font-claude-message',
      '[data-testid="assistant-message"]',
    ],
    user: ['[data-testid="user-message"]', '.font-user-message'],
    streaming: '[data-is-streaming="true"]',
    modelPicker: ['[data-testid="model-selector-dropdown"]'],
  };

  const POLL_MS = 500;          // how often to look at the page
  const STABLE_MS = 1500;       // a reply counts as finished after this long without changes
  const MIN_GROWTH_CHARS = 20;  // ignore tiny changes (re-renders, timestamps)
  const HOVER_DELAY_MS = 120;
  const HINT_TIMES = 3;         // how many toasts mention the hover breakdown

  const DEFAULT_SETTINGS = {
    model: 'auto',        // auto | large | medium | small
    reasoning: 'some',    // none | some | extended
    powerPlant: false,    // add power-plant water to the headline number and totals
    countContext: true,   // the model re-reads the whole chat on every turn
    hidden: false,
  };
  const TIER_LABEL = { large: 'large model', medium: 'mid-size model', small: 'small model' };

  const emptyTotals = () => ({ v: 2, allTimeWh: 0, byDay: {}, byChat: {} });
  let settings = { ...DEFAULT_SETTINGS };
  let totals = emptyTotals();     // stored as energy (Wh) so water is always computed with current settings
  let pos = { right: 24, bottom: 120 };
  let hintsShown = 0;
  let lastReply = null;
  let lastHref = location.href;
  let alive = true;
  let animating = false;
  let tick = 0;
  const tracked = new WeakMap();

  /* ------------------------------------------------------------------ *
   * Storage (wrapped: calls throw once the extension is reloaded)
   * ------------------------------------------------------------------ */
  const storage = {
    async get(keys) {
      try { return (await chrome.storage.local.get(keys)) || {}; } catch { return {}; }
    },
    async set(obj) {
      try { await chrome.storage.local.set(obj); } catch { /* extension reloaded */ }
    },
  };

  const asObj = x => (x && typeof x === 'object' ? x : {});

  function normalizeTotals(t) {
    if (!t || typeof t !== 'object') return emptyTotals();
    if (t.v === 2) {
      return { v: 2, allTimeWh: Number(t.allTimeWh) || 0, byDay: asObj(t.byDay), byChat: asObj(t.byChat) };
    }
    // v0.1 stored millilitres of cooling water; convert back to energy.
    const out = emptyTotals();
    out.allTimeWh = (Number(t.allTime) || 0) / V1_ML_PER_WH;
    for (const [d, ml] of Object.entries(asObj(t.byDay))) out.byDay[d] = (Number(ml) || 0) / V1_ML_PER_WH;
    for (const [c, v] of Object.entries(asObj(t.byChat))) {
      out.byChat[c] = { wh: (Number(v && v.ml) || 0) / V1_ML_PER_WH, t: (v && v.t) || 0 };
    }
    return out;
  }

  function prune(t) {
    const days = Object.keys(t.byDay).sort();
    while (days.length > 60) delete t.byDay[days.shift()];
    const chats = Object.entries(t.byChat).sort((a, b) => a[1].t - b[1].t);
    while (chats.length > 200) delete t.byChat[chats.shift()[0]];
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */
  const pad = n => String(n).padStart(2, '0');
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const chatKey = () => (location.pathname.match(/\/chat\/([\w-]+)/) || [])[1] || location.pathname;
  const textLen = el => (el.textContent || '').trim().length;

  // Water for an amount of energy, following the "include power-plant water" setting.
  const mlPerWh = (level = 'mid') => COOLING_ML_PER_WH[level] + (settings.powerPlant ? POWER_PLANT_ML_PER_WH : 0);
  const water = (wh, level) => wh * mlPerWh(level);
  const chatWh = () => (totals.byChat[chatKey()] || {}).wh || 0;

  function queryTop(list) {
    for (const sel of list) {
      const els = [...document.querySelectorAll(sel)];
      if (els.length) return els.filter(e => !els.some(o => o !== e && o.contains(e)));
    }
    return [];
  }

  function fmtMl(ml) {
    if (ml < 0.995) return `${ml.toFixed(2)} mL`;
    if (ml < 9.95) return `${ml.toFixed(1)} mL`;
    if (ml < 999.5) return `${Math.round(ml)} mL`;
    return `${(ml / 1000).toFixed(2)} L`;
  }

  function compare(ml) {
    if (ml < 2) {
      const drops = Math.max(1, Math.round(ml / 0.05));
      return `about ${drops} drop${drops === 1 ? '' : 's'}`;
    }
    if (ml < 15) {
      const tsp = Math.max(0.5, Math.round((ml / 5) * 2) / 2);
      if (tsp === 0.5) return 'about half a teaspoon';
      if (tsp === 1) return 'about a teaspoon';
      return `about ${tsp} teaspoons`;
    }
    if (ml < 60) {
      const tbsp = Math.round((ml / 15) * 2) / 2;
      return tbsp === 1 ? 'about a tablespoon' : `about ${tbsp} tablespoons`;
    }
    if (ml < GLASS_ML) return `about ${Math.round((ml / GLASS_ML) * 100)}% of a glass`;
    return `about ${(ml / GLASS_ML).toFixed(1)} glasses`;
  }

  const fmtTok = n => (n < 1000 ? String(Math.round(n)) : `${(n / 1000).toFixed(1)}k`);
  const fmtWh = wh => (wh < 10 ? wh.toFixed(1) : String(Math.round(wh)));

  /* ------------------------------------------------------------------ *
   * Estimation
   * ------------------------------------------------------------------ */
  function detectModel() {
    let name = '';
    for (const sel of SELECTORS.modelPicker) {
      const el = document.querySelector(sel);
      if (el) { name = el.textContent.trim(); break; }
    }
    if (!name) {
      for (const b of document.querySelectorAll('button')) {
        const t = (b.textContent || '').trim();
        if (t.length < 40 && /\b(opus|sonnet|haiku|fable|mythos)\b/i.test(t)) { name = t; break; }
      }
    }
    const autoTier = /haiku/i.test(name) ? 'small' : /sonnet/i.test(name) ? 'medium' : 'large';
    if (settings.model === 'auto') return { tier: autoTier, name: name || TIER_LABEL[autoTier] };
    return { tier: settings.model, name: TIER_LABEL[settings.model] };
  }

  // Energy for one reply, split into reading, writing and thinking.
  function estimate(newChars, cachedChars, outChars) {
    const { tier, name } = detectModel();
    const scale = MODEL_SCALE[tier] ?? 1;
    const factor = REASONING_FACTOR[settings.reasoning] ?? 1;
    const newInTok = newChars / CHARS_PER_TOKEN;
    const cachedTok = cachedChars / CHARS_PER_TOKEN;
    const outTok = outChars / CHARS_PER_TOKEN;
    const readWh = ((newInTok + cachedTok * CACHED_READ_SHARE) / 1000) * WH_PER_1K_INPUT_TOKENS * scale;
    const writeWh = (outTok / 1000) * WH_PER_1K_OUTPUT_TOKENS * scale;
    const thinkWh = (readWh + writeWh) * (factor - 1);
    return { newInTok, cachedTok, outTok, readWh, writeWh, thinkWh, wh: readWh + writeWh + thinkWh, name };
  }

  // What the model read to write `current`: your latest message (new) and the chat before it (re-read).
  function promptParts(current) {
    const isBefore = e => !!(e.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING);
    const users = queryTop(SELECTORS.user).filter(isBefore);
    if (!users.length) return { newChars: FALLBACK_PROMPT_CHARS, cachedChars: 0 };
    const newChars = textLen(users[users.length - 1]);
    if (!settings.countContext) return { newChars, cachedChars: 0 };
    const replies = queryTop(SELECTORS.assistant).filter(e => e !== current && isBefore(e));
    const cachedChars = [...users.slice(0, -1), ...replies].reduce((sum, e) => sum + textLen(e), 0);
    return { newChars, cachedChars };
  }

  /* ------------------------------------------------------------------ *
   * Watching the page for finished replies
   * ------------------------------------------------------------------ */
  function poll() {
    if (!alive) return;
    if (!chrome.runtime || !chrome.runtime.id) { alive = false; return; } // extension removed/reloaded
    tick++;
    ui.ensureMounted();
    if (tick % 4 === 0) ui.applyTheme();
    if (location.href !== lastHref) { lastHref = location.href; lastReply = null; ui.render(); }

    const replies = queryTop(SELECTORS.assistant);
    const el = replies[replies.length - 1];
    if (!el) return;

    const now = Date.now();
    const len = textLen(el);
    let st = tracked.get(el);
    if (!st) {
      // Replies already on the page when it loads never "grow", so they're never counted.
      tracked.set(el, { len, changedAt: now, growths: 0, firstLen: len, countedLen: null });
      return;
    }
    if (len !== st.len) {
      if (len < st.len * 0.5) { st.firstLen = len; st.growths = 0; st.countedLen = null; } // regenerated
      else if (len > st.len) st.growths++;
      st.len = len;
      st.changedAt = now;
      return;
    }
    if (now - st.changedAt < STABLE_MS) return;
    if (document.querySelector(SELECTORS.streaming)) return;

    if (st.countedLen === null) {
      if (st.growths >= 2 && len - st.firstLen >= MIN_GROWTH_CHARS) {
        st.countedLen = len;
        record(el, promptParts(el), len, false);
      }
    } else if (len - st.countedLen >= MIN_GROWTH_CHARS) {
      // The reply paused (e.g. a web search) and then kept writing: add the extra part.
      const extra = len - st.countedLen;
      st.countedLen = len;
      record(el, { newChars: 0, cachedChars: 0 }, extra, true);
    }
  }

  async function record(el, parts, outChars, isTopUp) {
    const est = estimate(parts.newChars, parts.cachedChars, outChars);
    if (isTopUp && lastReply && lastReply.el === el) {
      for (const k of ['outTok', 'readWh', 'writeWh', 'thinkWh', 'wh']) lastReply[k] += est[k];
    } else {
      lastReply = { el, ...est };
    }

    const fresh = (await storage.get('totals')).totals; // merge with other open tabs
    if (fresh) totals = normalizeTotals(fresh);
    const d = dayKey();
    const c = chatKey();
    totals.allTimeWh += est.wh;
    totals.byDay[d] = (totals.byDay[d] || 0) + est.wh;
    const chat = totals.byChat[c] || { wh: 0, t: 0 };
    chat.wh += est.wh;
    chat.t = Date.now();
    totals.byChat[c] = chat;
    prune(totals);
    animating = true; // keep the storage listener from filling the glass before the drop lands
    await storage.set({ totals });
    ui.celebrate(water(est.wh));
  }

  /* ------------------------------------------------------------------ *
   * UI: a glass in the corner, a falling drop, a toast, and a breakdown
   * card that appears on hover (or focus) and stays open on click.
   * Lives in a shadow root so claude.ai's styles and ours never mix.
   * ------------------------------------------------------------------ */
  const GLASS_PATH = 'M5 4 L39 4 L35.2 51 Q35 54 32 54 L12 54 Q9 54 8.8 51 Z';

  const CSS = `
    :host { all: initial; position: fixed; z-index: 2147483000; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    .wrap { --bg:#ffffff; --fg:#1f1e1d; --muted:#6b6a66; --line:rgba(0,0,0,.09); --track:rgba(0,0,0,.06); --glass:rgba(70,70,70,.55);
            --water:#2f86d6; --water2:#7cbcf0; --plant:#8b93a3; --shadow:0 8px 28px rgba(0,0,0,.14), 0 1px 3px rgba(0,0,0,.08);
            position: relative; width: 48px; height: 60px; }
    .wrap[data-theme="dark"] { --bg:#2a2927; --fg:#f3f1ec; --muted:#a8a59d; --line:rgba(255,255,255,.1); --track:rgba(255,255,255,.08);
            --glass:rgba(235,235,235,.6); --water:#4ea6f2; --water2:#8fc9f7; --plant:#8790a0; --shadow:0 8px 28px rgba(0,0,0,.45); }

    .glass-btn { all: unset; position: absolute; inset: 0; display: grid; place-items: center; cursor: grab; border-radius: 12px; }
    .glass-btn:active { cursor: grabbing; }
    .glass-btn:focus-visible { outline: 2px solid var(--water); outline-offset: 2px; }
    .glass { width: 44px; height: 56px; overflow: visible; filter: drop-shadow(0 1px 2px rgba(0,0,0,.12)); }
    .outline { fill: none; stroke: var(--glass); stroke-width: 2; stroke-linejoin: round; }
    .shine { fill: none; stroke: var(--glass); stroke-width: 1.4; stroke-linecap: round; opacity: .35; }
    .water { transition: transform 1.1s cubic-bezier(.2,.8,.2,1); }
    .wave { fill: var(--water); animation: wave 3.2s linear infinite; }
    .wave.back { fill: var(--water2); opacity: .7; animation-duration: 4.6s; animation-direction: reverse; }
    @keyframes wave { from { transform: translateX(0); } to { transform: translateX(-44px); } }

    .badge { position: absolute; top: -4px; right: -6px; min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box;
             border-radius: 9px; background: var(--water); color: #fff; font: 600 10.5px/18px inherit; text-align: center;
             box-shadow: 0 1px 3px rgba(0,0,0,.2); pointer-events: none; }
    .badge[hidden] { display: none; }

    .drop { position: absolute; left: 50%; top: 0; width: 14px; height: 20px; margin-left: -7px; opacity: 0; pointer-events: none; }
    .drop path { fill: var(--water); }
    .drop.fall { animation: fall .72s cubic-bezier(.55,0,.85,.4) forwards; }
    @keyframes fall {
      0%   { transform: translateY(-72px) scale(var(--s,1)); opacity: 0; }
      15%  { opacity: 1; }
      82%  { transform: translateY(var(--land,20px)) scale(var(--s,1)); opacity: 1; }
      100% { transform: translateY(calc(var(--land,20px) + 6px)) scale(calc(var(--s,1) * .5)); opacity: 0; }
    }
    .ripple { position: absolute; left: 50%; width: 26px; height: 7px; margin-left: -13px; border-radius: 50%;
              border: 1.5px solid var(--water2); opacity: 0; pointer-events: none; }
    .ripple.go { animation: ripple .7s ease-out forwards; }
    @keyframes ripple { from { transform: scale(.2); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }

    .toast { position: absolute; bottom: 6px; right: 58px; padding: 8px 12px; border-radius: 12px; background: var(--bg); color: var(--fg);
             box-shadow: var(--shadow); border: 1px solid var(--line); white-space: nowrap; pointer-events: none;
             opacity: 0; transform: translateX(8px) scale(.98); transition: opacity .25s ease, transform .3s cubic-bezier(.2,.8,.2,1); }
    .toast.show { opacity: 1; transform: none; }
    .t-ml { display: block; font-size: 15px; font-weight: 650; color: var(--water); letter-spacing: -.01em; }
    .t-cmp { display: block; font-size: 12px; color: var(--muted); margin-top: 1px; }
    .t-hint { display: block; font-size: 11px; color: var(--muted); margin-top: 3px; opacity: .85; }
    .t-hint:empty { display: none; }

    .card { position: absolute; bottom: 70px; right: 0; width: 292px; padding: 14px 16px 12px; border-radius: 14px; box-sizing: border-box;
            background: var(--bg); color: var(--fg); box-shadow: var(--shadow); border: 1px solid var(--line); font-size: 13px; line-height: 1.4;
            pointer-events: none; animation: pop .16s ease-out; }
    .card.pinned { pointer-events: auto; }
    .card[hidden] { display: none; }
    @keyframes pop { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    .head { display: flex; justify-content: space-between; align-items: center; }
    .close { all: unset; cursor: pointer; color: var(--muted); font-size: 18px; line-height: 1; padding: 0 3px; border-radius: 4px; }
    .close:focus-visible { outline: 2px solid var(--water); }
    .label { font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
    .big { font-size: 22px; font-weight: 650; color: var(--water); letter-spacing: -.01em; margin-top: 2px; }
    .big small { font-size: 12.5px; font-weight: 500; color: var(--muted); margin-left: 6px; letter-spacing: 0; }
    .detail { font-size: 11.5px; color: var(--muted); margin-top: 2px; }
    .sec { margin-top: 12px; }
    .stack { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--track); margin: 6px 0 4px; }
    .stack i { display: block; height: 100%; }
    .stack i + i { margin-left: 2px; }
    .c-cool { background: var(--water); }
    .c-plant { background: var(--plant); }
    .leg { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 12.5px; }
    .sw { width: 8px; height: 8px; border-radius: 2px; flex: none; }
    .v { margin-left: auto; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .v.off { font-weight: 500; color: var(--muted); }
    .bar-row { display: grid; grid-template-columns: 1fr auto; column-gap: 10px; padding: 3px 0 2px; font-size: 12.5px; }
    .bar { grid-column: 1 / -1; height: 5px; border-radius: 3px; background: var(--track); overflow: hidden; margin-top: 3px; }
    .bar i { display: block; height: 100%; background: var(--water); border-radius: 3px; }
    .rows { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 8px; }
    .row { display: flex; justify-content: space-between; padding: 2px 0; }
    .row span:last-child { font-weight: 600; font-variant-numeric: tabular-nums; }
    .note { margin-top: 8px; font-size: 11px; color: var(--muted); }

    .wrap.flip-x .toast { right: auto; left: 58px; transform: translateX(-8px) scale(.98); }
    .wrap.flip-x .toast.show { transform: none; }
    .wrap.flip-x .card { right: auto; left: 0; }
    .wrap.flip-y .card { bottom: auto; top: 70px; }

    @media (prefers-reduced-motion: reduce) {
      .wave { animation: none; } .water { transition: none; } .card { animation: none; }
      .toast { transition: opacity .2s; transform: none; }
    }
  `;

  const ui = (() => {
    let host, root, wrap, btn, waterG, badge, drop, ripple, toast, tMl, tCmp, tHint, card, toastTimer, hoverTimer;
    let mode = null;          // null | 'hover' | 'pinned'
    let dragging = false;
    let justDragged = false;
    const svgNS = 'http://www.w3.org/2000/svg';
    const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function el(tag, attrs = {}, parent, ns) {
      const n = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'text') n.textContent = v;
        else if (k === 'style') n.style.cssText = v; // CSSOM, so a strict page CSP doesn't block it
        else n.setAttribute(k, v);
      }
      if (parent) parent.appendChild(n);
      return n;
    }

    function mount() {
      host = el('div', { id: 'droplet-water-estimate' });
      root = host.attachShadow({ mode: 'open' });
      try {
        // Constructable stylesheets aren't blocked by a page's style-src policy, unlike <style> tags.
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        root.adoptedStyleSheets = [sheet];
      } catch {
        el('style', { text: CSS }, root);
      }
      wrap = el('div', { class: 'wrap' }, root);

      toast = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }, wrap);
      tMl = el('span', { class: 't-ml' }, toast);
      tCmp = el('span', { class: 't-cmp' }, toast);
      tHint = el('span', { class: 't-hint' }, toast);

      card = el('div', { class: 'card', id: 'droplet-card', role: 'dialog', 'aria-label': 'Water breakdown', hidden: '' }, wrap);

      btn = el('button', { class: 'glass-btn', type: 'button', 'aria-describedby': 'droplet-card', 'aria-expanded': 'false' }, wrap);
      const svg = el('svg', { class: 'glass', viewBox: '0 0 44 56', 'aria-hidden': 'true' }, btn, svgNS);
      const defs = el('defs', {}, svg, svgNS);
      const clip = el('clipPath', { id: 'droplet-clip' }, defs, svgNS);
      el('path', { d: GLASS_PATH }, clip, svgNS);
      const g = el('g', { 'clip-path': 'url(#droplet-clip)' }, svg, svgNS);
      waterG = el('g', { class: 'water' }, g, svgNS);
      const wavePath = 'M0 0 Q11 -3.2 22 0 T44 0 T66 0 T88 0 L88 64 L0 64 Z';
      el('path', { class: 'wave back', d: wavePath, transform: 'translate(0 -1.5)' }, waterG, svgNS);
      el('path', { class: 'wave', d: wavePath }, waterG, svgNS);
      el('path', { class: 'outline', d: GLASS_PATH }, svg, svgNS);
      el('path', { class: 'shine', d: 'M10 10 L12.5 44' }, svg, svgNS);

      badge = el('span', { class: 'badge', hidden: '' }, btn);
      drop = el('svg', { class: 'drop', viewBox: '0 0 14 20', 'aria-hidden': 'true' }, wrap, svgNS);
      el('path', { d: 'M7 0 C7 0 0 8.6 0 13 A7 7 0 0 0 14 13 C14 8.6 7 0 7 0 Z' }, drop, svgNS);
      ripple = el('span', { class: 'ripple' }, wrap);

      wireDrag();
      wireCard();

      document.body.appendChild(host);
      applyPos();
      applyTheme();
      applyHidden();
      render();
    }

    function ensureMounted() {
      if (host && !host.isConnected && document.body) document.body.appendChild(host);
    }

    /* --- hover shows the breakdown, click pins it, Esc or × closes --- */
    function openCard(m) {
      mode = m;
      card.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      toast.classList.remove('show');
      renderCard();
    }
    function closeCard() {
      mode = null;
      card.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
    function wireCard() {
      btn.addEventListener('pointerenter', () => {
        if (mode) return;
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => { if (!mode && !dragging) openCard('hover'); }, HOVER_DELAY_MS);
      });
      btn.addEventListener('pointerleave', () => {
        clearTimeout(hoverTimer);
        if (mode === 'hover' && !dragging) closeCard();
      });
      btn.addEventListener('focus', () => { if (!mode && btn.matches(':focus-visible')) openCard('hover'); });
      btn.addEventListener('blur', () => { if (mode === 'hover') closeCard(); });
      btn.addEventListener('click', () => {
        if (justDragged) { justDragged = false; return; }
        if (mode === 'pinned') closeCard(); else openCard('pinned');
      });
      root.addEventListener('keydown', e => { if (e.key === 'Escape' && mode) { closeCard(); btn.focus(); } });
    }

    function wireDrag() {
      let start = null;
      btn.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        start = { x: e.clientX, y: e.clientY, right: pos.right, bottom: pos.bottom };
        btn.setPointerCapture(e.pointerId);
      });
      btn.addEventListener('pointermove', e => {
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (!dragging && Math.hypot(dx, dy) < 5) return;
        if (!dragging) { dragging = true; clearTimeout(hoverTimer); if (mode === 'hover') closeCard(); }
        pos.right = Math.min(Math.max(4, start.right - dx), window.innerWidth - 56);
        pos.bottom = Math.min(Math.max(4, start.bottom - dy), window.innerHeight - 68);
        applyPos();
      });
      const end = () => {
        if (start && dragging) { justDragged = true; storage.set({ pos }); }
        start = null;
        dragging = false;
      };
      btn.addEventListener('pointerup', end);
      btn.addEventListener('pointercancel', end);
    }

    function applyPos() {
      if (!host) return;
      host.style.right = `${pos.right}px`;
      host.style.bottom = `${pos.bottom}px`;
      wrap.classList.toggle('flip-x', pos.right > window.innerWidth / 2);
      wrap.classList.toggle('flip-y', pos.bottom > window.innerHeight / 2);
    }

    function applyTheme() {
      if (!wrap) return;
      const parse = node => {
        const m = (getComputedStyle(node).backgroundColor.match(/[\d.]+/g) || []).map(Number);
        return m.length >= 3 && (m[3] === undefined || m[3] > 0.5) ? m : null;
      };
      const c = parse(document.body) || parse(document.documentElement);
      const dark = c
        ? (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 < 0.5
        : window.matchMedia('(prefers-color-scheme: dark)').matches;
      wrap.dataset.theme = dark ? 'dark' : 'light';
    }

    function applyHidden() {
      if (host) host.style.display = settings.hidden ? 'none' : '';
    }

    // Surface position of the water, in px from the top of the glass (4 = brim, 54 = bottom).
    function surfaceY() {
      const ml = water(chatWh());
      if (ml <= 0) return 58;
      const frac = ml >= GLASS_ML && ml % GLASS_ML < 1 ? 1 : (ml % GLASS_ML) / GLASS_ML;
      return 54 - Math.max(0.08, frac) * 48;
    }

    function render() {
      if (!host) return;
      const ml = water(chatWh());
      waterG.style.transform = `translateY(${surfaceY()}px)`;
      const full = Math.floor(ml / GLASS_ML);
      badge.hidden = full < 1;
      badge.textContent = `×${full}`;
      btn.setAttribute('aria-label', `Water estimate: about ${fmtMl(ml)} in this chat. Hover or press for the breakdown; drag to move.`);
      if (!card.hidden) renderCard();
    }

    /* --- the breakdown card --- */
    function renderCard() {
      card.textContent = '';
      card.classList.toggle('pinned', mode === 'pinned');

      const head = el('div', { class: 'head' }, card);
      el('span', { class: 'label', text: 'Last reply' }, head);
      if (mode === 'pinned') {
        const x = el('button', { class: 'close', type: 'button', 'aria-label': 'Close', text: '×' }, head);
        x.addEventListener('click', e => { e.stopPropagation(); closeCard(); });
      }

      if (!lastReply) {
        el('div', { class: 'detail', text: 'Send a message and the next reply will be broken down here.' }, card);
      } else {
        const r = lastReply;
        const ml = water(r.wh);
        const big = el('div', { class: 'big', text: `≈ ${fmtMl(ml)}` }, card);
        el('small', { text: compare(ml) }, big);
        el('div', { class: 'detail', text: `Likely range ${fmtMl(water(r.wh, 'low'))} – ${fmtMl(water(r.wh, 'high'))}` }, card);

        // Where the water goes: cooling vs electricity generation (always shown, so the hidden part is visible).
        const cool = r.wh * COOLING_ML_PER_WH.mid;
        const plant = r.wh * POWER_PLANT_ML_PER_WH;
        const sec1 = el('div', { class: 'sec' }, card);
        el('div', { class: 'label', text: 'Where the water goes' }, sec1);
        const stack = el('div', { class: 'stack', 'aria-hidden': 'true' }, sec1);
        el('i', { class: 'c-cool', style: `width:${(cool / (cool + plant)) * 100}%` }, stack);
        el('i', { class: `c-plant`, style: `width:${(plant / (cool + plant)) * 100}%; opacity:${settings.powerPlant ? 1 : 0.45}` }, stack);
        const leg = (cls, label, value, off) => {
          const row = el('div', { class: 'leg' }, sec1);
          el('span', { class: `sw ${cls}`, style: off ? 'opacity:.45' : '' }, row);
          el('span', { text: label }, row);
          el('span', { class: `v${off ? ' off' : ''}`, text: value }, row);
        };
        leg('c-cool', 'Cooling the servers', fmtMl(cool), false);
        leg('c-plant', 'Power plants', settings.powerPlant ? fmtMl(plant) : `${fmtMl(plant)} · not in total`, !settings.powerPlant);

        // What used it: reading, writing, thinking (in the same units as the headline).
        const sec2 = el('div', { class: 'sec' }, card);
        el('div', { class: 'label', text: 'What used it' }, sec2);
        const parts = [
          ['Reading the chat', r.readWh],
          ['Writing the reply', r.writeWh],
          ['Thinking', r.thinkWh],
        ].filter(([, wh]) => wh > 0);
        for (const [label, wh] of parts) {
          const row = el('div', { class: 'bar-row' }, sec2);
          el('span', { text: label }, row);
          el('span', { class: 'v', text: `${fmtMl(water(wh))} · ${Math.round((wh / r.wh) * 100)}%` }, row);
          const bar = el('div', { class: 'bar', 'aria-hidden': 'true' }, row);
          el('i', { style: `width:${(wh / r.wh) * 100}%` }, bar);
        }
        const reread = r.cachedTok > 0 ? ` + ${fmtTok(r.cachedTok)} re-read` : '';
        el('div', {
          class: 'detail',
          text: `~${fmtTok(r.newInTok)} new${reread} tokens · ${fmtTok(r.outTok)} written · ${fmtWh(r.wh)} Wh · ${r.name}`,
        }, sec2);
      }

      const rows = el('div', { class: 'rows' }, card);
      const row = (k, v) => { const rr = el('div', { class: 'row' }, rows); el('span', { text: k }, rr); el('span', { text: v }, rr); };
      row('This chat', fmtMl(water(chatWh())));
      row('Today', fmtMl(water(totals.byDay[dayKey()] || 0)));
      row('All time', fmtMl(water(totals.allTimeWh)));

      el('div', {
        class: 'note',
        text: `${settings.powerPlant ? 'Totals include cooling and power-plant water' : 'Totals are cooling water only'}. ` +
              'Rough estimate from public research; Anthropic doesn’t publish water figures.',
      }, card);
    }

    function showToast(ml) {
      tMl.textContent = `+${fmtMl(ml)}`;
      tCmp.textContent = `${compare(ml)} of water`;
      tHint.textContent = '';
      if (hintsShown < HINT_TIMES) {
        tHint.textContent = 'Hover the glass for the breakdown';
        hintsShown++;
        storage.set({ hintsShown });
      }
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 4500);
    }

    function celebrate(ml) {
      const finish = () => { animating = false; render(); if (mode === null) showToast(ml); };
      if (!host || settings.hidden) { animating = false; render(); return; }
      if (reduceMotion()) { finish(); return; }
      const s = Math.min(1.6, Math.max(0.7, 0.75 + Math.log10(ml + 1) * 0.45));
      const land = Math.min(surfaceY(), 50) - 16;
      drop.style.setProperty('--s', s.toFixed(2));
      drop.style.setProperty('--land', `${land}px`);
      drop.classList.remove('fall');
      void drop.getBoundingClientRect(); // restart the animation
      drop.classList.add('fall');
      setTimeout(() => {
        finish();
        ripple.style.top = `${surfaceY() - 1}px`;
        ripple.classList.remove('go');
        void ripple.offsetWidth;
        ripple.classList.add('go');
      }, 620);
    }

    window.addEventListener('resize', () => applyPos());
    return { mount, ensureMounted, render, celebrate, applyTheme, applyHidden };
  })();

  /* ------------------------------------------------------------------ *
   * Start
   * ------------------------------------------------------------------ */
  async function init() {
    const saved = await storage.get(['settings', 'totals', 'pos', 'hintsShown']);
    settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
    totals = normalizeTotals(saved.totals);
    hintsShown = Number(saved.hintsShown) || 0;
    if (saved.pos && Number.isFinite(saved.pos.right) && Number.isFinite(saved.pos.bottom)) pos = saved.pos;
    ui.mount();
    setInterval(poll, POLL_MS);

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.settings) {
          settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
          ui.applyHidden();
        }
        if (changes.totals) {
          totals = normalizeTotals(changes.totals.newValue);
          if (!changes.totals.newValue) lastReply = null; // reset from the popup
        }
        if (!animating) ui.render();
      });
    } catch { /* extension reloaded */ }
  }

  init();
})();
