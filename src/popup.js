'use strict';
(function () {
  const RP = globalThis.RP;
  const $ = (id) => document.getElementById(id);
  let settings = RP.normalizeSettings({});
  let host = '';
  let port = null;
  let output = '';

  function applyTheme() {
    const dark = settings.theme === 'dark' || (settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }

  function timeAgo(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return new Date(ts).toLocaleDateString();
  }

  function renderSite() {
    if (!host) return;
    const off = settings.disabledSites.includes(host);
    $('siteCard').hidden = false;
    $('host').textContent = host;
    $('siteState').textContent = off ? 'Icons are hidden on this site' : 'Icons are shown on this site';
    $('siteToggle').textContent = off ? 'Show here' : 'Hide here';
  }

  async function toggleSite() {
    const sites = settings.disabledSites.filter((h) => h !== host);
    if (sites.length === settings.disabledSites.length) sites.push(host);
    settings.disabledSites = sites;
    await chrome.storage.sync.set({ disabledSites: sites });
    renderSite();
  }

  async function renderHistory() {
    const { history = [] } = await chrome.storage.local.get('history');
    const list = $('history');
    list.textContent = '';
    $('historyCard').hidden = !history.length;
    for (const item of history) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'item';
      btn.title = 'Copy this rewrite';
      const top = document.createElement('div');
      top.className = 'top';
      const left = document.createElement('span');
      left.textContent = [RP.getMode(item.mode).label, item.lang, item.host].filter(Boolean).join(' · ');
      const right = document.createElement('span');
      right.textContent = timeAgo(item.ts);
      top.append(left, right);
      const text = document.createElement('div');
      text.className = 'text';
      text.dir = 'auto';
      text.textContent = item.result;
      btn.append(top, text);
      btn.addEventListener('click', async () => {
        await copy(item.result);
        right.textContent = 'Copied';
        setTimeout(() => (right.textContent = timeAgo(item.ts)), 1200);
      });
      list.append(btn);
    }
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      return false;
    }
  }

  function setBusy(busy) {
    $('go').textContent = busy ? 'Stop' : 'Rewrite';
    $('go').classList.toggle('primary', !busy);
  }

  function stop() {
    if (!port) return;
    const p = port;
    port = null;
    try {
      p.disconnect();
    } catch (_) { /* already closed */ }
    setBusy(false);
  }

  function showOutput(text, isError) {
    $('output').hidden = false;
    $('output').classList.toggle('err', !!isError);
    $('output').textContent = text;
  }

  function go() {
    if (port) return stop();
    const text = $('input').value;
    if (!text.trim()) return $('input').focus();
    output = '';
    $('outputBar').hidden = true;
    showOutput('Rewriting…', false);
    setBusy(true);

    const p = chrome.runtime.connect({ name: 'rp-rewrite' });
    port = p;
    let lang = '';
    p.onMessage.addListener((msg) => {
      if (port !== p || !msg) return;
      if (msg.type === 'lang') lang = msg.lang || '';
      else if (msg.type === 'delta') {
        output += msg.text;
        showOutput(output, false);
      } else if (msg.type === 'reset') {
        output = '';
        showOutput('Rewriting…', false);
      } else if (msg.type === 'done') {
        output = msg.text;
        port = null;
        setBusy(false);
        showOutput(output, false);
        $('outputBar').hidden = false;
        $('copyOut').textContent = 'Copy';
        $('outMeta').textContent = [msg.lang || lang, RP.countWords(text) + ' → ' + RP.countWords(output) + ' words', msg.truncated ? 'may be incomplete' : '']
          .filter(Boolean)
          .join(' · ');
        setTimeout(renderHistory, 300);
      } else if (msg.type === 'error') {
        port = null;
        setBusy(false);
        showOutput(msg.message, true);
        if (msg.code === 'no_key' || msg.code === 'auth') $('setup').hidden = false;
      }
    });
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port !== p) return;
      port = null;
      setBusy(false);
      if (!output) showOutput('The request was interrupted. Try again.', true);
    });
    p.postMessage({ type: 'start', text, mode: $('mode').value, outputLang: settings.outputLang, instruction: '' });
  }

  async function init() {
    settings = await RP.loadSettings();
    applyTheme();

    for (const m of RP.MODES) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.label;
      $('mode').append(o);
    }
    $('mode').value = settings.defaultMode;

    const { apiKey = '' } = await chrome.storage.local.get('apiKey');
    $('setup').hidden = !!apiKey;

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tab && tab.url ? new URL(tab.url) : null;
      if (url && /^https?:$/.test(url.protocol)) host = url.hostname.toLowerCase();
    } catch (_) { /* no access to this tab */ }
    renderSite();
    renderHistory();

    const open = () => chrome.runtime.openOptionsPage();
    $('openOptions').addEventListener('click', open);
    $('setupBtn').addEventListener('click', open);
    $('siteToggle').addEventListener('click', toggleSite);
    $('go').addEventListener('click', go);
    $('input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) go();
    });
    $('copyOut').addEventListener('click', async () => {
      $('copyOut').textContent = (await copy(output)) ? 'Copied' : 'Copy failed';
    });
    $('clearHistory').addEventListener('click', async () => {
      await chrome.storage.local.remove('history');
      renderHistory();
    });
    $('input').focus();
  }

  init();
})();
