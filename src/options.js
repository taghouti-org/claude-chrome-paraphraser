'use strict';
(function () {
  const RP = globalThis.RP;
  const $ = (id) => document.getElementById(id);

  function applyTheme(theme) {
    const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }

  function fillSelect(el, items) {
    for (const [value, label] of items) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      el.append(o);
    }
  }

  let savedTimer = 0;
  function flashSaved() {
    $('saved').textContent = 'Saved';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => ($('saved').textContent = ''), 1500);
  }

  function setNote(el, text, kind) {
    el.textContent = text;
    el.className = 'note' + (kind ? ' ' + kind : '');
  }

  async function savePref(patch) {
    try {
      await chrome.storage.sync.set(patch);
      flashSaved();
    } catch (err) {
      $('saved').textContent = '';
      alertInline('Could not save: ' + ((err && err.message) || 'storage error'));
    }
  }

  function alertInline(text) {
    setNote($('keyStatus'), text, 'err');
  }

  function parseSites(text) {
    const out = [];
    for (let line of text.split(/[\n,]+/)) {
      line = line.trim().toLowerCase();
      if (!line) continue;
      // Accept pasted URLs as well as bare hosts.
      try {
        line = new URL(line.includes('://') ? line : 'https://' + line).hostname;
      } catch (_) {
        continue;
      }
      if (line && !out.includes(line)) out.push(line);
    }
    return out;
  }

  async function init() {
    fillSelect($('model'), RP.MODELS.map((m) => [m.id, m.label]));
    fillSelect($('defaultMode'), RP.MODES.map((m) => [m.id, m.label + ' — ' + m.hint]));
    fillSelect($('outputLang'), [['auto', 'Same as the original text']].concat(RP.LANGUAGES.map((l) => [l, 'Always ' + l])));

    const s = await RP.loadSettings();
    applyTheme(s.theme);
    $('model').value = s.model;
    $('defaultMode').value = s.defaultMode;
    $('outputLang').value = s.outputLang;
    $('theme').value = s.theme;
    $('customInstructions').value = s.customInstructions;
    $('selectionIcon').checked = s.selectionIcon;
    $('fieldIcon').checked = s.fieldIcon;
    $('saveHistory').checked = s.saveHistory;
    $('disabledSites').value = s.disabledSites.join('\n');

    const { apiKey = '' } = await chrome.storage.local.get('apiKey');
    $('key').value = apiKey;
    setNote($('keyStatus'), apiKey ? 'A key is saved.' : 'No key saved yet.', apiKey ? 'ok' : '');

    for (const id of ['model', 'defaultMode', 'outputLang']) {
      $(id).addEventListener('change', () => savePref({ [id]: $(id).value }));
    }
    $('theme').addEventListener('change', () => {
      applyTheme($('theme').value);
      savePref({ theme: $('theme').value });
    });
    for (const id of ['selectionIcon', 'fieldIcon', 'saveHistory']) {
      $(id).addEventListener('change', () => savePref({ [id]: $(id).checked }));
    }
    $('customInstructions').addEventListener('change', () =>
      savePref({ customInstructions: $('customInstructions').value.trim().slice(0, 1000) })
    );
    $('disabledSites').addEventListener('change', () => {
      const sites = parseSites($('disabledSites').value);
      $('disabledSites').value = sites.join('\n');
      savePref({ disabledSites: sites });
    });

    $('toggleKey').addEventListener('click', () => {
      const show = $('key').type === 'password';
      $('key').type = show ? 'text' : 'password';
      $('toggleKey').textContent = show ? 'Hide' : 'Show';
      $('toggleKey').setAttribute('aria-pressed', String(show));
    });

    $('saveKey').addEventListener('click', saveKey);
    $('key').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveKey();
    });

    $('removeKey').addEventListener('click', async () => {
      await chrome.storage.local.remove('apiKey');
      $('key').value = '';
      setNote($('keyStatus'), 'Key removed from this browser.', '');
    });

    $('clearHistory').addEventListener('click', async () => {
      await chrome.storage.local.remove('history');
      setNote($('historyStatus'), 'History cleared.', 'ok');
    });

    $('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme($('theme').value));
  }

  async function saveKey() {
    const key = $('key').value.trim();
    if (!key) return setNote($('keyStatus'), 'Paste your API key first.', 'err');
    $('saveKey').disabled = true;
    setNote($('keyStatus'), 'Checking the key…', '');
    try {
      await chrome.storage.local.set({ apiKey: key });
      const res = await chrome.runtime.sendMessage({ type: 'rp-test-key', apiKey: key });
      if (res && res.ok) setNote($('keyStatus'), 'Key saved and verified. You are ready to go.', 'ok');
      else setNote($('keyStatus'), 'Key saved, but the check failed: ' + ((res && res.message) || 'no response from the extension.'), 'err');
    } catch (err) {
      setNote($('keyStatus'), 'Could not save the key: ' + ((err && err.message) || 'unknown error'), 'err');
    } finally {
      $('saveKey').disabled = false;
    }
  }

  init().catch((err) => alertInline('Settings failed to load: ' + ((err && err.message) || err)));
})();
