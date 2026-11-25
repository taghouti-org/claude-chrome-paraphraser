// Service worker: owns the API key, talks to the Claude API and streams
// results back to content scripts / the popup over a runtime port.
'use strict';
importScripts('shared.js', 'api.js');

const RP = self.RP;

// Keep the API key and history out of reach of content scripts (which run
// inside web page processes). Preferences stay in storage.sync.
function lockLocalStorage() {
  try {
    const p = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    if (p && p.catch) p.catch(() => {});
  } catch (_) { /* older Chrome */ }
}
lockLocalStorage();

// ---------- context menu ----------

const MENU_MODES = ['standard', 'grammar', 'humanize', 'formal', 'casual', 'concise'];

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: 'rp-root',
      title: 'Rephraser',
      contexts: ['selection', 'editable'],
    }, () => void chrome.runtime.lastError);
    for (const id of MENU_MODES) {
      chrome.contextMenus.create({
        id: 'rp-mode-' + id,
        parentId: 'rp-root',
        title: RP.getMode(id).label,
        contexts: ['selection', 'editable'],
      }, () => void chrome.runtime.lastError);
    }
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  buildMenus();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(buildMenus);

function sendRun(tabId, modeId, frameId) {
  if (tabId == null || tabId < 0) return;
  const opts = typeof frameId === 'number' ? { frameId } : undefined;
  const done = () => void chrome.runtime.lastError; // page without our content script
  // Without a frame id the message reaches every frame; the content script
  // then lets only the focused one react.
  if (opts) chrome.tabs.sendMessage(tabId, { type: 'rp-run', mode: modeId, broadcast: false }, opts, done);
  else chrome.tabs.sendMessage(tabId, { type: 'rp-run', mode: modeId, broadcast: true }, done);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  if (!id.startsWith('rp-mode-') || !tab) return;
  sendRun(tab.id, id.slice('rp-mode-'.length), info.frameId);
});

const COMMAND_MODES = {
  'paraphrase-selection': null, // null = the user's default mode
  'humanize-selection': 'humanize',
  'grammar-selection': 'grammar',
};

chrome.commands.onCommand.addListener((command, tab) => {
  if (!(command in COMMAND_MODES)) return;
  const run = (t) => t && sendRun(t.id, COMMAND_MODES[command]);
  if (tab) run(tab);
  else chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => run(tabs && tabs[0]));
});

// ---------- history ----------

let historyChain = Promise.resolve();

function addHistory(entry) {
  historyChain = historyChain
    .then(async () => {
      const { history = [] } = await chrome.storage.local.get('history');
      history.unshift(entry);
      await chrome.storage.local.set({ history: history.slice(0, RP.HISTORY_LIMIT) });
    })
    .catch(() => {});
  return historyChain;
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname : '';
  } catch (_) {
    return '';
  }
}

// ---------- streaming jobs ----------

let activeJobs = 0;
let keepAliveTimer = null;

// A slow stretch with no stream output must not let the worker go idle.
function jobStarted() {
  activeJobs++;
  if (!keepAliveTimer) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError), 20000);
  }
}
function jobEnded() {
  activeJobs = Math.max(0, activeJobs - 1);
  if (!activeJobs && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rp-rewrite') return;
  // Only this extension's own contexts may start a job.
  if (!port.sender || port.sender.id !== chrome.runtime.id) {
    port.disconnect();
    return;
  }
  const controller = new AbortController();
  let open = true;
  let started = false;

  const post = (msg) => {
    if (!open) return;
    try {
      port.postMessage(msg);
    } catch (_) {
      open = false;
    }
  };

  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    open = false;
    controller.abort();
  });

  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'start' || started) return;
    started = true;
    jobStarted();
    try {
      const [settings, local] = await Promise.all([RP.loadSettings(), chrome.storage.local.get('apiKey')]);
      const modeId = RP.getMode(msg.mode || settings.defaultMode).id;
      const outputLang =
        msg.outputLang === 'auto' || RP.LANGUAGES.includes(msg.outputLang) ? msg.outputLang : settings.outputLang;
      const result = await RP.api.rewrite(
        {
          apiKey: (local.apiKey || '').trim(),
          model: settings.model,
          text: String(msg.text || ''),
          modeId,
          outputLang,
          instruction: String(msg.instruction || '').slice(0, 500),
          customInstructions: settings.customInstructions,
          signal: controller.signal,
        },
        {
          onLang: (lang) => post({ type: 'lang', lang }),
          onDelta: (text) => post({ type: 'delta', text }),
          onReset: () => post({ type: 'reset' }),
        }
      );
      post({ type: 'done', text: result.text, lang: result.lang, truncated: result.truncated });
      if (settings.saveHistory && open) {
        await addHistory({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          ts: Date.now(),
          mode: modeId,
          lang: result.lang,
          source: String(msg.text || '').slice(0, 4000),
          result: result.text.slice(0, 8000),
          host: hostOf(port.sender.url || (port.sender.tab && port.sender.tab.url) || ''),
        });
      }
    } catch (err) {
      if (!(err && err.name === 'AbortError')) {
        post({
          type: 'error',
          code: (err && err.code) || 'error',
          message: (err && err.message) || 'Something went wrong.',
        });
      }
    } finally {
      jobEnded();
      if (open) {
        try {
          port.disconnect();
        } catch (_) { /* already closed */ }
        open = false;
      }
    }
  });
});

// ---------- one-shot messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender || sender.id !== chrome.runtime.id) return;
  if (msg.type === 'rp-open-options') {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (msg.type === 'rp-test-key') {
    RP.api
      .testKey(String(msg.apiKey || '').trim())
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, message: (err && err.message) || 'The key could not be verified.' }));
    return true; // async response
  }
});
