// Content script: selection icon, field icon, result panel and in-place
// replacement. All UI lives in a closed shadow root so page styles and scripts
// cannot interfere with it (and vice versa).
(function () {
  'use strict';
  if (globalThis.__rpContentLoaded) return;
  globalThis.__rpContentLoaded = true;
  if (!(document.documentElement instanceof HTMLElement)) return; // XML, SVG documents

  const RP = globalThis.RP;
  const MIN_SELECTION = 2; // characters
  const MIN_FIELD_TEXT = 8; // characters before the field icon appears
  const BTN = 26; // icon size in px

  let settings = RP.normalizeSettings({});
  let enabled = true;
  let ui = null;
  let pending = null; // { target, anchor } waiting behind the selection icon
  let field = null; // focused editable field
  let fieldObserver = null;
  let session = null; // open panel
  let mouseDown = false;
  let toastTimer = 0;
  let rafPending = false;
  let dead = false;

  // ---------------------------------------------------------------- helpers

  function alive() {
    try {
      return !!chrome.runtime.id;
    } catch (_) {
      return false;
    }
  }

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children) if (c != null) el.append(c);
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(paths, size) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size || 16);
    svg.setAttribute('height', size || 16);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }
  const ICONS = {
    spark: ['M12 3l1.9 5.6a2 2 0 0 0 1.3 1.3L21 12l-5.8 2.1a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.6a2 2 0 0 0-1.3-1.3L3 12l5.8-2.1a2 2 0 0 0 1.3-1.3z'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    gear: [
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
      'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    ],
    retry: ['M21 12a9 9 0 1 1-2.6-6.4', 'M21 4v5h-5'],
    copy: ['M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z', 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'],
  };

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function deepActiveElement() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  function isTextControl(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el instanceof HTMLTextAreaElement) return true;
    return el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'search');
  }

  function editableRoot(node) {
    let el = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
    if (!el || !el.isContentEditable) return null;
    while (el.parentElement && el.parentElement.isContentEditable) el = el.parentElement;
    return el;
  }

  function fieldCandidate(el) {
    if (!el || (ui && el === ui.host)) return null;
    if (isTextControl(el)) return el.type === 'search' ? null : el;
    return editableRoot(el);
  }

  function rectOf(r) {
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }

  function rangeAnchor(range) {
    const rects = range.getClientRects();
    for (let i = rects.length - 1; i >= 0; i--) {
      if (rects[i].width > 0 || rects[i].height > 0) return rectOf(rects[i]);
    }
    const r = range.getBoundingClientRect();
    return r.width || r.height ? rectOf(r) : null;
  }

  function inViewport(a) {
    return a && a.bottom > 0 && a.top < innerHeight && a.right > 0 && a.left < innerWidth;
  }

  // ---------------------------------------------------------------- targets

  // A target describes what will be rewritten and how to put text back.
  function captureSelection() {
    const ae = deepActiveElement();
    if (isTextControl(ae)) {
      const start = ae.selectionStart;
      const end = ae.selectionEnd;
      if (start == null || end == null || start === end) return null;
      return { kind: 'input', el: ae, start, end, text: ae.value.slice(start, end), editable: true };
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const text = sel.toString();
    if (!text) return null;
    const range = sel.getRangeAt(0).cloneRange();
    const root = editableRoot(range.commonAncestorContainer);
    if (ui && ui.host.contains(range.commonAncestorContainer)) return null;
    return { kind: root ? 'ce' : 'static', el: root, range, rangeText: range.toString(), text, editable: !!root };
  }

  // The selection inside a field if there is one, otherwise the whole field.
  function captureField(el) {
    if (!el || !el.isConnected) return null;
    const sel = captureSelection();
    if (sel && sel.el === el && sel.text.trim().length >= MIN_SELECTION) return sel;
    if (isTextControl(el)) {
      if (!el.value.trim()) return null;
      return { kind: 'input', el, start: 0, end: el.value.length, text: el.value, editable: true, whole: true };
    }
    const text = el.innerText;
    if (!text.trim()) return null;
    return { kind: 'ce', el, text, snapshot: text, editable: true, whole: true };
  }

  function targetAnchor(t) {
    if (t.kind !== 'input' && t.range) {
      const a = rangeAnchor(t.range);
      if (a) return a;
    }
    return t.el && t.el.isConnected ? rectOf(t.el.getBoundingClientRect()) : null;
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function replaceInInput(t, text) {
    const el = t.el;
    if (!el || !el.isConnected || el.disabled || el.readOnly) return false;
    if (el instanceof HTMLInputElement) text = text.replace(/\s*\n+\s*/g, ' ');
    const before = el.value;
    let { start, end } = t;
    if (before.slice(start, end) !== t.text) {
      // The field changed since the text was captured: find the text again,
      // and give up if it is gone or ambiguous rather than overwrite blindly.
      const at = before.indexOf(t.text);
      if (at === -1 || before.indexOf(t.text, at + 1) !== -1) return false;
      start = at;
      end = at + t.text.length;
    }
    el.focus({ preventScroll: true });
    el.setSelectionRange(start, end);
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch (_) { /* fall through */ }
    const expected = before.slice(0, start) + text + before.slice(end);
    if (!ok || el.value !== expected) {
      setNativeValue(el, expected);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      try {
        el.setSelectionRange(start + text.length, start + text.length);
      } catch (_) { /* not focusable anymore */ }
    }
    if (el.value !== expected) return false;
    t.start = start;
    t.end = start + text.length;
    t.text = text;
    t.whole = false;
    return true;
  }

  function replaceInEditable(t, text) {
    const root = t.el;
    if (!root || !root.isConnected || !root.isContentEditable) return false;
    let range;
    if (t.whole) {
      if (root.innerText !== t.snapshot) return false;
      range = document.createRange();
      range.selectNodeContents(root);
    } else {
      range = t.range;
      if (!range || range.collapsed || !root.contains(range.commonAncestorContainer)) return false;
      if (range.toString() !== t.rangeText) return false;
    }
    root.focus({ preventScroll: true });
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch (_) { /* fall through */ }
    if (!ok) {
      // Editors that ignore execCommand usually accept a paste.
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const node = sel.anchorNode;
        const dispatchOn = (node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)) || root;
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        ok = !dispatchOn.dispatchEvent(ev); // handled when the editor cancels it
      } catch (_) {
        ok = false;
      }
    }
    return ok;
  }

  function replaceTarget(t, text) {
    try {
      if (t.kind === 'input') return replaceInInput(t, text);
      if (t.kind === 'ce') return replaceInEditable(t, text);
    } catch (_) { /* treated as failure */ }
    return false;
  }

  // ---------------------------------------------------------------- UI shell

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  --bg: #ffffff; --fg: #1c1d22; --muted: #6b6f7b; --line: #e3e4ea; --soft: #f3f4f7;
  --accent: #5146e5; --accent-fg: #ffffff; --accent-soft: #ecebfd; --danger: #b93227;
  --shadow: 0 10px 34px rgba(16, 18, 35, .18), 0 1px 3px rgba(16, 18, 35, .12);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--fg);
}
.root[data-theme="dark"] {
  --bg: #1f2027; --fg: #ececf1; --muted: #9a9eab; --line: #353743; --soft: #2a2c36;
  --accent: #8f88ff; --accent-fg: #15151b; --accent-soft: #2e2d4d; --danger: #ff8479;
  --shadow: 0 10px 34px rgba(0, 0, 0, .5), 0 1px 3px rgba(0, 0, 0, .4);
}
[hidden] { display: none !important; }
button { font: inherit; color: inherit; cursor: pointer; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.fab {
  position: fixed; width: ${BTN}px; height: ${BTN}px; padding: 0; display: grid; place-items: center;
  border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--accent);
  box-shadow: 0 2px 8px rgba(16, 18, 35, .18); pointer-events: auto;
  transition: transform .12s ease, background .12s ease;
}
.fab:hover { transform: scale(1.08); background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.fab.field { opacity: .82; }
.fab.field:hover, .fab.field.open { opacity: 1; }

.menu {
  position: fixed; width: 264px; max-height: min(360px, calc(100vh - 16px)); overflow: auto; padding: 5px;
  background: var(--bg); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow);
  pointer-events: auto;
}
.menu button {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px; width: 100%;
  padding: 6px 9px; border: 0; border-radius: 6px; background: none; text-align: start;
}
.menu button:hover { background: var(--soft); }
.menu .hint { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.menu button > span:first-child { white-space: nowrap; }

.panel {
  position: fixed; display: flex; flex-direction: column; overflow: hidden;
  background: var(--bg); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow);
  pointer-events: auto;
}
.head { display: flex; align-items: center; gap: 7px; padding: 8px 8px 8px 12px; cursor: move; user-select: none; }
.head .logo { color: var(--accent); display: grid; }
.head .title { font-weight: 600; }
.badge {
  padding: 1px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent);
  font-size: 11px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 170px;
}
.grow { flex: 1; }
.iconbtn {
  width: 26px; height: 26px; padding: 0; display: grid; place-items: center; border: 0; border-radius: 6px;
  background: none; color: var(--muted);
}
.iconbtn:hover { background: var(--soft); color: var(--fg); }
.modes { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 12px 8px; }
.chip {
  padding: 3px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); color: var(--fg);
  font-size: 12px; white-space: nowrap;
}
.chip:hover { background: var(--soft); }
.chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.opts { display: flex; gap: 6px; padding: 0 12px 8px; }
.opts select, .opts input {
  height: 28px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); color: var(--fg);
  font: inherit; font-size: 12px; padding: 0 8px; min-width: 0;
}
.opts select { flex: 0 0 132px; }
.opts input { flex: 1; }
.opts input::placeholder { color: var(--muted); }
.body {
  flex: 1; min-height: 64px; overflow: auto; margin: 0 12px; padding: 10px 12px;
  background: var(--soft); border-radius: 9px;
}
.result { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.55; user-select: text; cursor: text; }
.status { display: flex; align-items: center; gap: 8px; color: var(--muted); }
.spinner {
  width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--accent);
  animation: rp-spin .8s linear infinite; flex: none;
}
@keyframes rp-spin { to { transform: rotate(360deg); } }
.error { color: var(--danger); overflow-wrap: anywhere; }
.error button {
  display: block; margin-top: 8px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 7px;
  background: var(--bg); color: var(--fg);
}
.foot { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 9px 12px 11px; }
.meta { color: var(--muted); font-size: 11px; }
.btn {
  height: 30px; padding: 0 12px; display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); font-weight: 500;
  white-space: nowrap;
}
.btn:hover:not(:disabled) { background: var(--soft); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.btn.primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
.btn:disabled, .iconbtn:disabled { opacity: .45; cursor: default; }

.toast {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); max-width: min(460px, calc(100vw - 24px));
  display: flex; align-items: center; gap: 12px; padding: 9px 14px; border-radius: 10px;
  background: #23242b; color: #f2f2f5; box-shadow: var(--shadow); pointer-events: auto; font-size: 13px;
}
.toast button { border: 0; background: none; color: #a9a4ff; font-weight: 600; padding: 0; }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } .fab { transition: none; } }
`;

  function ensureUI() {
    if (ui) {
      if (!ui.host.isConnected) document.documentElement.append(ui.host);
      return ui;
    }
    const host = document.createElement('rephraser-ui');
    host.setAttribute('aria-live', 'off');
    host.style.cssText =
      'all:initial!important;position:fixed!important;top:0!important;left:0!important;width:0!important;' +
      'height:0!important;margin:0!important;padding:0!important;border:0!important;overflow:visible!important;' +
      'background:transparent!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch (_) {
      shadow.append(h('style', { text: CSS }));
    }
    const root = h('div', { class: 'root' });
    shadow.append(root);

    // Keep our clicks from moving the page's focus or collapsing its
    // selection, except on controls that need focus themselves.
    root.addEventListener('mousedown', (e) => {
      const el = e.composedPath()[0];
      const tag = el && el.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'OPTION') return;
      if (el && el.closest && el.closest('.result')) return; // allow selecting result text
      e.preventDefault();
    });
    // Typing in the panel must not trigger the page's keyboard shortcuts.
    for (const type of ['keydown', 'keyup', 'keypress', 'input', 'paste', 'copy', 'cut']) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }

    const bubble = h('button', { class: 'fab', title: 'Rephrase selection', 'aria-label': 'Rephrase selection', hidden: true }, icon(ICONS.spark, 15));
    bubble.addEventListener('click', onBubbleClick);

    const fieldBtn = h('button', { class: 'fab field', title: 'Rephrase this text', 'aria-label': 'Rephrase this text', 'aria-haspopup': 'menu', hidden: true }, icon(ICONS.spark, 15));
    fieldBtn.addEventListener('click', onFieldBtnClick);

    const menu = h('div', { class: 'menu', role: 'menu', hidden: true });
    for (const m of RP.MODES) {
      menu.append(
        h('button', { role: 'menuitem', onclick: () => onMenuPick(m.id) }, h('span', { text: m.label }), h('span', { class: 'hint', text: m.hint }))
      );
    }

    const toast = h('div', { class: 'toast', role: 'status', hidden: true });

    root.append(bubble, fieldBtn, menu, toast);
    document.documentElement.append(host);
    ui = { host, shadow, root, bubble, fieldBtn, menu, toast, panel: null };
    applyTheme();
    return ui;
  }

  // Shows the host in the top layer so it stays above modal dialogs and
  // fullscreen elements where the browser allows it.
  function raise() {
    if (!ui || typeof ui.host.showPopover !== 'function') return;
    try {
      if (!ui.host.hasAttribute('popover')) ui.host.setAttribute('popover', 'manual');
      if (ui.host.matches(':popover-open')) ui.host.hidePopover();
      ui.host.showPopover();
    } catch (_) { /* not supported in this document */ }
  }

  function applyTheme() {
    if (!ui) return;
    let theme = settings.theme;
    if (theme === 'auto') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    ui.root.dataset.theme = theme;
  }

  function showToast(message, action) {
    const u = ensureUI();
    clearTimeout(toastTimer);
    u.toast.textContent = '';
    u.toast.append(h('span', { text: message }));
    if (action) {
      u.toast.append(
        h('button', {
          text: action.label,
          onclick: () => {
            hideToast();
            action.run();
          },
        })
      );
    }
    u.toast.hidden = false;
    raise();
    toastTimer = setTimeout(hideToast, action ? 7000 : 3500);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    if (ui) ui.toast.hidden = true;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) { /* insecure page or document not focused: use the legacy path */ }
    const u = ensureUI();
    const prev = deepActiveElement();
    const ta = h('textarea', { 'aria-hidden': 'true', tabindex: '-1' });
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    ta.value = text;
    u.root.append(ta);
    let ok = false;
    try {
      ta.select();
      ok = document.execCommand('copy');
    } catch (_) {
      ok = false;
    }
    ta.remove();
    if (prev && prev.focus) {
      try {
        prev.focus({ preventScroll: true });
      } catch (_) { /* element gone */ }
    }
    return ok;
  }

  // ---------------------------------------------------------------- selection icon

  function hideBubble() {
    pending = null;
    if (ui) ui.bubble.hidden = true;
  }

  function placeBubble(anchor) {
    const u = ensureUI();
    u.bubble.style.left = clamp(anchor.right + 6, 6, innerWidth - BTN - 6) + 'px';
    u.bubble.style.top = clamp(anchor.bottom + 6, 6, innerHeight - BTN - 6) + 'px';
    u.bubble.hidden = false;
  }

  function evaluateSelection(mouse) {
    if (dead || session) return;
    if (!enabled || !settings.selectionIcon) return hideBubble();
    const t = captureSelection();
    if (!t || t.text.trim().length < MIN_SELECTION) return hideBubble();
    let anchor;
    if (t.kind === 'input') {
      anchor = mouse ? { left: mouse.x, right: mouse.x, top: mouse.y, bottom: mouse.y + 8 } : rectOf(t.el.getBoundingClientRect());
    } else {
      anchor = rangeAnchor(t.range);
    }
    if (!inViewport(anchor)) return hideBubble();
    pending = { target: t, anchor };
    placeBubble(anchor);
    raise();
  }

  function refreshBubble() {
    if (!pending || !ui || ui.bubble.hidden) return;
    const t = pending.target;
    if (t.kind === 'input') return hideBubble();
    const anchor = rangeAnchor(t.range);
    if (!inViewport(anchor)) return hideBubble();
    pending.anchor = anchor;
    placeBubble(anchor);
  }

  function onBubbleClick() {
    if (!pending) return;
    const { target, anchor } = pending;
    // The selection may have been extended since the icon appeared.
    const fresh = captureSelection();
    hideBubble();
    openPanel(fresh && fresh.text.trim().length >= MIN_SELECTION ? fresh : target, settings.defaultMode, anchor);
  }

  // ---------------------------------------------------------------- field icon

  function setField(el) {
    if (el === field) return;
    if (fieldObserver) fieldObserver.disconnect();
    field = el;
    closeMenu();
    if (el && typeof ResizeObserver === 'function') {
      fieldObserver = fieldObserver || new ResizeObserver(scheduleLayout);
      fieldObserver.observe(el);
    }
    updateFieldBtn();
  }

  function fieldTextLength(el) {
    return isTextControl(el) ? el.value.trim().length : (el.textContent || '').trim().length;
  }

  function updateFieldBtn() {
    if (!ui && !field) return;
    const show =
      !dead && enabled && settings.fieldIcon && !session && field && field.isConnected && fieldTextLength(field) >= MIN_FIELD_TEXT;
    if (!show) {
      if (ui) {
        ui.fieldBtn.hidden = true;
        closeMenu();
      }
      return;
    }
    const r = field.getBoundingClientRect();
    if (r.width < 140 || r.height < 18 || !inViewport(r)) {
      if (ui) {
        ui.fieldBtn.hidden = true;
        closeMenu();
      }
      return;
    }
    const u = ensureUI();
    // Shrink the icon in short single-line fields so it stays inside them.
    const size = Math.round(clamp(r.height - 4, 18, BTN));
    const single = r.height < 44;
    const scrollbar = Math.max(0, field.offsetWidth - field.clientWidth - 4);
    const inset = single ? Math.max(2, (r.height - size) / 2) : 6;
    const left = r.right - size - Math.max(4, inset) - scrollbar;
    const top = single ? r.top + (r.height - size) / 2 : r.bottom - size - inset;
    const wasHidden = u.fieldBtn.hidden;
    u.fieldBtn.style.width = size + 'px';
    u.fieldBtn.style.height = size + 'px';
    u.fieldBtn.style.left = clamp(left, 4, innerWidth - size - 4) + 'px';
    u.fieldBtn.style.top = clamp(top, 4, innerHeight - size - 4) + 'px';
    u.fieldBtn.hidden = false;
    if (wasHidden) raise();
    if (!u.menu.hidden) placeMenu();
  }

  function placeMenu() {
    const b = ui.fieldBtn.getBoundingClientRect();
    const m = ui.menu;
    const height = Math.min(m.scrollHeight + 2, 360, innerHeight - 16);
    const top = b.top - height - 6 >= 8 ? b.top - height - 6 : Math.min(b.bottom + 6, innerHeight - height - 8);
    m.style.left = clamp(b.right - 264, 8, Math.max(8, innerWidth - 264 - 8)) + 'px';
    m.style.top = Math.max(8, top) + 'px';
  }

  function closeMenu() {
    if (!ui || ui.menu.hidden) return;
    ui.menu.hidden = true;
    ui.fieldBtn.classList.remove('open');
    ui.fieldBtn.setAttribute('aria-expanded', 'false');
  }

  function onFieldBtnClick() {
    if (!ui.menu.hidden) return closeMenu();
    hideBubble();
    ui.menu.hidden = false;
    ui.fieldBtn.classList.add('open');
    ui.fieldBtn.setAttribute('aria-expanded', 'true');
    placeMenu();
    raise();
  }

  function onMenuPick(modeId) {
    const anchor = rectOf(ui.fieldBtn.getBoundingClientRect());
    const t = captureField(field);
    closeMenu();
    if (!t) return showToast('This field is empty.');
    openPanel(t, modeId, anchor);
  }

  function scheduleLayout() {
    if (rafPending || dead) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      updateFieldBtn();
      refreshBubble();
    });
  }

  // ---------------------------------------------------------------- panel

  function buildPanel() {
    const p = {};
    p.badge = h('span', { class: 'badge', hidden: true });
    p.close = h('button', { class: 'iconbtn', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closePanel }, icon(ICONS.close, 15));
    p.gear = h('button', { class: 'iconbtn', title: 'Settings', 'aria-label': 'Settings', onclick: openOptions }, icon(ICONS.gear, 15));
    p.head = h(
      'div',
      { class: 'head' },
      h('span', { class: 'logo' }, icon(ICONS.spark, 16)),
      h('span', { class: 'title', text: 'Rephraser' }),
      p.badge,
      h('span', { class: 'grow' }),
      p.gear,
      p.close
    );

    p.chips = new Map();
    p.modes = h('div', { class: 'modes', role: 'group', 'aria-label': 'Mode' });
    for (const m of RP.MODES) {
      const chip = h('button', { class: 'chip', title: m.hint, 'aria-pressed': 'false', text: m.label, onclick: () => run({ mode: m.id }) });
      p.chips.set(m.id, chip);
      p.modes.append(chip);
    }

    p.lang = h('select', { title: 'Output language', 'aria-label': 'Output language' }, h('option', { value: 'auto', text: 'Same language' }));
    for (const l of RP.LANGUAGES) p.lang.append(h('option', { value: l, text: '→ ' + l }));
    p.lang.addEventListener('change', () => {
      if (!session) return;
      session.outLang = p.lang.value;
      run({ mode: session.mode });
    });
    p.instruction = h('input', {
      type: 'text',
      maxlength: '300',
      placeholder: 'Extra instruction, then Enter (optional)',
      'aria-label': 'Extra instruction',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    p.instruction.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && session) {
        e.preventDefault();
        session.instruction = p.instruction.value.trim();
        run({ mode: session.mode });
      }
    });
    p.opts = h('div', { class: 'opts' }, p.lang, p.instruction);

    p.result = h('div', { class: 'result', dir: 'auto', hidden: true });
    p.status = h('div', { class: 'status', hidden: true }, h('span', { class: 'spinner' }), h('span', { text: 'Rewriting…' }));
    p.errorText = h('span');
    p.errorBtn = h('button', { hidden: true });
    p.error = h('div', { class: 'error', role: 'alert', hidden: true }, p.errorText, p.errorBtn);
    p.body = h('div', { class: 'body', 'aria-live': 'polite' }, p.status, p.result, p.error);

    p.meta = h('span', { class: 'meta' });
    p.retry = h('button', { class: 'iconbtn', title: 'Try another version', 'aria-label': 'Try another version', onclick: () => session && run({ mode: session.mode }) }, icon(ICONS.retry, 15));
    p.copy = h('button', { class: 'btn', onclick: onCopy }, icon(ICONS.copy, 14), h('span', { text: 'Copy' }));
    p.humanize = h('button', { class: 'btn', onclick: onHumanize });
    p.replace = h('button', { class: 'btn primary', text: 'Replace', onclick: () => doReplace() });
    p.foot = h('div', { class: 'foot' }, p.meta, h('span', { class: 'grow' }), p.retry, p.copy, p.humanize, p.replace);

    p.el = h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Rephraser', hidden: true }, p.head, p.modes, p.opts, p.body, p.foot);
    enableDrag(p);
    return p;
  }

  function enableDrag(p) {
    let drag = null;
    p.head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.composedPath().some((n) => n.tagName === 'BUTTON')) return;
      const r = p.el.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
      p.el.style.bottom = 'auto';
      p.el.style.left = r.left + 'px';
      p.el.style.top = r.top + 'px';
      p.el.style.maxHeight = Math.max(200, innerHeight - r.top - 8) + 'px';
      p.head.setPointerCapture(e.pointerId);
    });
    p.head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const left = clamp(e.clientX - drag.dx, 4, Math.max(4, innerWidth - drag.w - 4));
      const top = clamp(e.clientY - drag.dy, 4, Math.max(4, innerHeight - 48));
      p.el.style.left = left + 'px';
      p.el.style.top = top + 'px';
      p.el.style.maxHeight = Math.max(200, innerHeight - top - 8) + 'px';
    });
    const end = (e) => {
      if (!drag) return;
      drag = null;
      try {
        p.head.releasePointerCapture(e.pointerId);
      } catch (_) { /* capture already gone */ }
    };
    p.head.addEventListener('pointerup', end);
    p.head.addEventListener('pointercancel', end);
  }

  function placePanel(anchor) {
    const el = ui.panel.el;
    const width = Math.min(410, innerWidth - 16);
    const a = anchor || { left: innerWidth / 2 - width / 2, right: innerWidth / 2 + width / 2, top: 80, bottom: 80 };
    el.style.width = width + 'px';
    el.style.left = clamp(a.right - width + 40, 8, Math.max(8, innerWidth - width - 8)) + 'px';
    const below = innerHeight - a.bottom - 16;
    const above = a.top - 16;
    if (below >= 300 || below >= above) {
      el.style.top = clamp(a.bottom + 8, 8, Math.max(8, innerHeight - 208)) + 'px';
      el.style.bottom = 'auto';
      el.style.maxHeight = Math.max(200, Math.min(520, below)) + 'px';
    } else {
      el.style.top = 'auto';
      el.style.bottom = clamp(innerHeight - a.top + 8, 8, Math.max(8, innerHeight - 208)) + 'px';
      el.style.maxHeight = Math.max(200, Math.min(520, above)) + 'px';
    }
  }

  function openPanel(target, modeId, anchor) {
    const u = ensureUI();
    if (session) closePanel();
    if (!u.panel) {
      u.panel = buildPanel();
      u.root.append(u.panel.el);
    }
    hideBubble();
    hideToast();
    session = {
      target,
      source: target.text,
      mode: RP.getMode(modeId || settings.defaultMode).id,
      outLang: settings.outputLang,
      instruction: '',
      input: target.text,
      result: '',
      lang: '',
      status: 'idle',
      message: '',
      truncated: false,
      autoReplace: false,
      job: null,
    };
    u.panel.lang.value = session.outLang;
    u.panel.instruction.value = '';
    u.panel.el.hidden = false;
    placePanel(anchor || targetAnchor(target));
    updateFieldBtn();
    raise();
    run({ mode: session.mode });
  }

  function cancelJob() {
    if (!session || !session.job) return;
    const { port } = session.job;
    session.job = null;
    try {
      port.disconnect();
    } catch (_) { /* already closed */ }
  }

  function closePanel() {
    if (!session) return;
    cancelJob();
    session = null;
    if (ui && ui.panel) ui.panel.el.hidden = true;
    updateFieldBtn();
  }

  function openOptions() {
    try {
      chrome.runtime.sendMessage({ type: 'rp-open-options' }, () => void chrome.runtime.lastError);
    } catch (_) {
      showToast('Rephraser was updated. Reload this page to keep using it.');
    }
  }

  function render() {
    const s = session;
    if (!s || !ui || !ui.panel) return;
    const p = ui.panel;
    for (const [id, chip] of p.chips) chip.setAttribute('aria-pressed', String(id === s.mode));

    const busy = s.status === 'loading' || s.status === 'streaming';
    p.status.hidden = s.status !== 'loading';
    p.result.hidden = !(s.status === 'streaming' || s.status === 'done');
    p.error.hidden = s.status !== 'error';
    if (!p.result.hidden && p.result.textContent !== s.result) p.result.textContent = s.result;

    if (s.status === 'error') {
      p.errorText.textContent = s.message;
      const needsSetup = s.code === 'no_key' || s.code === 'auth' || s.code === 'model' || s.code === 'billing';
      p.errorBtn.hidden = false;
      p.errorBtn.textContent = needsSetup ? 'Open settings' : 'Try again';
      p.errorBtn.onclick = needsSetup ? openOptions : () => run({ mode: s.mode });
    }

    if (s.lang) {
      p.badge.hidden = false;
      p.badge.textContent = s.outLang !== 'auto' && s.outLang !== s.lang ? s.lang + ' → ' + s.outLang : s.lang;
      p.badge.title = 'Detected language: ' + s.lang;
    } else {
      p.badge.hidden = true;
    }

    const editable = s.target.editable;
    p.replace.hidden = !editable;
    p.humanize.textContent = editable ? 'Humanize & replace' : 'Humanize';
    p.humanize.title = editable
      ? 'Make it sound more natural, then put it in place of the original'
      : 'Make this result sound more natural';
    const ready = s.status === 'done' && !!s.result;
    p.copy.disabled = !ready;
    p.replace.disabled = !ready;
    p.humanize.disabled = busy;
    p.retry.disabled = busy;

    if (s.status === 'done') {
      const a = RP.countWords(s.source);
      const b = RP.countWords(s.result);
      p.meta.textContent = a + ' → ' + b + ' words' + (s.truncated ? ' · may be incomplete' : '');
    } else {
      p.meta.textContent = busy ? RP.getMode(s.mode).label + '…' : '';
    }
  }

  function fail(s, message, code) {
    s.status = 'error';
    s.message = message;
    s.code = code || 'error';
    s.autoReplace = false;
    render();
  }

  // Starts a rewrite. opts.source overrides the text sent (used to humanize a
  // result); the text that gets replaced on the page is always the original.
  function run(opts) {
    const s = session;
    if (!s) return;
    cancelJob();
    s.mode = RP.getMode(opts.mode).id;
    s.input = opts.source != null ? opts.source : s.source;
    s.result = '';
    s.status = 'loading';
    s.message = '';
    s.truncated = false;
    s.autoReplace = !!opts.autoReplace;
    const fromSource = opts.source == null;
    if (fromSource) s.lang = '';
    render();

    let port;
    try {
      port = chrome.runtime.connect({ name: 'rp-rewrite' });
    } catch (_) {
      return fail(s, 'Rephraser was updated or reloaded. Reload this page to keep using it.', 'reload');
    }
    const job = { port };
    s.job = job;
    const current = () => session === s && s.job === job;

    port.onMessage.addListener((msg) => {
      if (!current() || !msg) return;
      if (msg.type === 'lang') {
        if (fromSource && msg.lang) s.lang = msg.lang;
      } else if (msg.type === 'delta') {
        s.result += msg.text;
        s.status = 'streaming';
      } else if (msg.type === 'reset') {
        s.result = '';
        s.status = 'loading';
      } else if (msg.type === 'done') {
        s.result = msg.text;
        if (fromSource && msg.lang) s.lang = msg.lang;
        s.truncated = !!msg.truncated;
        s.status = 'done';
        s.job = null;
        render();
        if (s.autoReplace && !s.truncated) doReplace();
        return;
      } else if (msg.type === 'error') {
        s.job = null;
        return fail(s, msg.message, msg.code);
      }
      render();
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!current()) return;
      s.job = null;
      fail(s, 'The connection to the extension was interrupted. Try again.', 'disconnected');
    });
    try {
      port.postMessage({ type: 'start', text: s.input, mode: s.mode, outputLang: s.outLang, instruction: s.instruction });
    } catch (_) {
      s.job = null;
      fail(s, 'Rephraser was updated or reloaded. Reload this page to keep using it.', 'reload');
    }
  }

  function withOriginalSpacing(source, result) {
    const lead = source.match(/^\s*/)[0];
    const trail = source.match(/\s*$/)[0];
    return lead === source ? result : lead + result + trail;
  }

  async function onCopy() {
    const s = session;
    if (!s || s.status !== 'done') return;
    const ok = await copyText(s.result);
    showToast(ok ? 'Copied to clipboard.' : 'Could not copy. Select the text and press Ctrl+C.');
  }

  function onHumanize() {
    const s = session;
    if (!s) return;
    const base = s.status === 'done' && s.result ? s.result : null;
    run({ mode: 'humanize', source: base, autoReplace: s.target.editable });
  }

  async function doReplace() {
    const s = session;
    if (!s || s.status !== 'done' || !s.result || !s.target.editable) return;
    const t = s.target;
    const oldText = t.text;
    const newText = withOriginalSpacing(s.source, s.result);
    const rootBefore = t.kind === 'ce' && t.el ? t.el.innerText : null;
    const ok = replaceTarget(t, newText);
    if (!ok) {
      const copied = await copyText(s.result);
      showToast(
        copied
          ? 'Could not replace the text here, so it was copied to your clipboard instead.'
          : 'Could not replace the text here. Copy it from the panel instead.'
      );
      return;
    }
    const result = s.result;
    closePanel();
    showToast('Replaced.', { label: 'Undo', run: () => undoReplace(t, oldText) });
    if (t.kind === 'ce' && newText.trim() !== oldText.trim()) {
      // Some editors accept the command but ignore it; check once it settles.
      setTimeout(async () => {
        if (dead || !t.el || !t.el.isConnected || t.el.innerText !== rootBefore) return;
        const copied = await copyText(result);
        showToast(
          copied
            ? 'This editor did not accept the replacement, so the text was copied to your clipboard.'
            : 'This editor did not accept the replacement.'
        );
      }, 250);
    }
  }

  function undoReplace(t, oldText) {
    let ok = false;
    try {
      if (t.kind === 'input') {
        // After a replacement the target describes the inserted text.
        ok = replaceInInput(t, oldText);
      } else if (t.el && t.el.isConnected) {
        t.el.focus({ preventScroll: true });
        ok = document.execCommand('undo');
      }
    } catch (_) {
      ok = false;
    }
    if (!ok) showToast('Could not undo automatically. Press Ctrl+Z in the field.');
  }

  // ---------------------------------------------------------------- commands

  function runCommand(modeId, broadcast) {
    if (broadcast) {
      // Commands reach every frame; only the one holding focus should react.
      if (!document.hasFocus()) return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'IFRAME' || ae.tagName === 'FRAME')) return;
    }
    let t = captureSelection();
    if (!t || t.text.trim().length < MIN_SELECTION) t = captureField(fieldCandidate(deepActiveElement()));
    if (!t) return showToast('Select some text first.');
    openPanel(t, modeId || settings.defaultMode, targetAnchor(t));
  }

  // ---------------------------------------------------------------- events

  const fromUI = (e) => ui && e.target === ui.host;
  const listeners = [];
  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  }

  let selTimer = 0;
  function scheduleSelection(mouse, delay) {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => guard(() => evaluateSelection(mouse)), delay);
  }

  // Runs a handler unless the extension was reloaded under this page.
  function guard(fn) {
    if (dead) return;
    if (!alive()) return teardown();
    fn();
  }

  function teardown() {
    dead = true;
    clearTimeout(selTimer);
    clearTimeout(toastTimer);
    for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
    listeners.length = 0;
    if (fieldObserver) fieldObserver.disconnect();
    if (ui) ui.host.remove();
    ui = null;
    session = null;
    globalThis.__rpContentLoaded = false;
  }

  on(document, 'mousedown', (e) => {
    if (fromUI(e)) return;
    mouseDown = true;
    guard(() => {
      hideBubble();
      closeMenu();
      if (session) closePanel();
    });
  }, true);

  on(document, 'mouseup', (e) => {
    if (fromUI(e)) return;
    mouseDown = false;
    scheduleSelection({ x: e.clientX, y: e.clientY }, 10);
  }, true);

  on(document, 'keyup', (e) => {
    if (fromUI(e)) return;
    // Keyboard selection: Shift+arrows, Ctrl/Cmd+A, etc.
    if (e.shiftKey || e.key === 'Shift' || ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'a')) {
      scheduleSelection(null, 250);
    }
  }, true);

  on(document, 'selectionchange', () => {
    if (mouseDown || session || !pending) return;
    const sel = window.getSelection();
    const ae = deepActiveElement();
    const inputSel = isTextControl(ae) && ae.selectionStart !== ae.selectionEnd;
    if (!inputSel && (!sel || sel.isCollapsed)) hideBubble();
  });

  on(window, 'keydown', (e) => {
    if (e.key !== 'Escape' || dead) return;
    if (session || (ui && !ui.menu.hidden)) {
      // Consume it so the page does not also close its own dialog.
      e.preventDefault();
      e.stopImmediatePropagation();
      closeMenu();
      closePanel();
    } else if (pending) {
      hideBubble();
    }
  }, true);

  on(document, 'focusin', (e) => {
    if (fromUI(e)) return;
    guard(() => setField(fieldCandidate(e.target)));
  }, true);

  on(document, 'focusout', (e) => {
    if (fromUI(e)) return;
    setTimeout(() => {
      if (dead) return;
      const ae = deepActiveElement();
      if (ui && ae === ui.host) return; // focus moved into our panel
      setField(fieldCandidate(ae));
    }, 0);
  }, true);

  on(document, 'input', (e) => {
    if (fromUI(e)) return;
    if (pending) hideBubble();
    scheduleLayout();
  }, true);

  on(document, 'scroll', (e) => {
    if (fromUI(e)) return;
    scheduleLayout();
  }, { capture: true, passive: true });

  on(window, 'resize', () => {
    hideBubble();
    closeMenu();
    scheduleLayout();
  });

  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  on(darkQuery, 'change', applyTheme);

  function applySettings(next) {
    settings = next;
    const hostname = (location.hostname || '').toLowerCase();
    enabled = !settings.disabledSites.includes(hostname);
    applyTheme();
    if (!enabled || !settings.selectionIcon) hideBubble();
    updateFieldBtn();
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (dead || !msg || msg.type !== 'rp-run') return;
      runCommand(msg.mode, msg.broadcast === true);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (dead || area !== 'sync') return;
      RP.loadSettings().then(applySettings).catch(() => {});
    });
    RP.loadSettings()
      .then((s) => {
        applySettings(s);
        setField(fieldCandidate(deepActiveElement()));
      })
      .catch(() => {});
  } catch (_) {
    teardown();
  }
})();
