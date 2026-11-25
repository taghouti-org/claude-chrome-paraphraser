// Shared constants and helpers. Loaded as a classic script by the service
// worker (importScripts), the content script, the popup and the options page.
(function (root) {
  'use strict';

  const MODES = [
    {
      id: 'standard',
      label: 'Paraphrase',
      hint: 'New wording, same meaning',
      prompt:
        'Paraphrase the text: use different wording and sentence structure while keeping the meaning, the tone and roughly the same length.',
    },
    {
      id: 'fluent',
      label: 'Fluent',
      hint: 'Smoother and more natural',
      prompt:
        'Rewrite the text so it flows smoothly and reads as if written by a fluent native speaker. Fix any grammar, spelling and awkward phrasing. Keep the tone and meaning.',
    },
    {
      id: 'grammar',
      label: 'Fix grammar',
      hint: 'Corrections only',
      prompt:
        'Correct grammar, spelling, punctuation and capitalization only. Change as little as possible: keep the author\'s wording, voice and structure wherever they are already correct. If the text has no errors, return it unchanged.',
    },
    {
      id: 'formal',
      label: 'Formal',
      hint: 'Professional register',
      prompt:
        'Rewrite the text in a formal, professional register suitable for business communication. Keep it clear and courteous, without stiffness or padding.',
    },
    {
      id: 'casual',
      label: 'Casual',
      hint: 'Friendly and relaxed',
      prompt:
        'Rewrite the text in a casual, friendly, conversational tone, the way one would write to a colleague they know well.',
    },
    {
      id: 'concise',
      label: 'Shorter',
      hint: 'Cut the length',
      prompt:
        'Rewrite the text to be noticeably shorter and tighter. Remove filler, redundancy and hedging while keeping every essential point.',
    },
    {
      id: 'expand',
      label: 'Longer',
      hint: 'Add detail',
      prompt:
        'Rewrite the text to be more developed and detailed: elaborate on the points already present and improve transitions. Do not invent facts, figures or claims that are not supported by the original.',
    },
    {
      id: 'simple',
      label: 'Simple',
      hint: 'Plain language',
      prompt:
        'Rewrite the text in plain, simple language that a general reader can follow easily: short sentences, common words, no jargon unless it is explained.',
    },
    {
      id: 'academic',
      label: 'Academic',
      hint: 'Scholarly style',
      prompt:
        'Rewrite the text in a precise academic style: objective tone, exact vocabulary, well-structured sentences. Keep all claims and any citations exactly as they are.',
    },
    {
      id: 'creative',
      label: 'Creative',
      hint: 'More vivid',
      prompt:
        'Rewrite the text in a more vivid, expressive and engaging way, with fresh word choices and imagery, while staying faithful to the meaning.',
    },
    {
      id: 'humanize',
      label: 'Humanize',
      hint: 'Natural, less robotic',
      prompt:
        'Rewrite the text so it sounds like a thoughtful person wrote it naturally. Vary sentence length and rhythm, prefer plain concrete words over inflated ones, use contractions where the register allows, and remove filler, stock phrases, formulaic transitions and over-tidy parallel structures. Keep the meaning, the facts and roughly the same length.',
    },
  ];

  // Target languages offered in the UI. "auto" keeps the source language.
  const LANGUAGES = [
    'English', 'French', 'Arabic', 'Spanish', 'German', 'Italian', 'Portuguese',
    'Dutch', 'Turkish', 'Russian', 'Polish', 'Ukrainian', 'Swedish', 'Greek',
    'Hindi', 'Chinese (Simplified)', 'Japanese', 'Korean', 'Indonesian', 'Vietnamese',
  ];

  const MODELS = [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — best quality (default)' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — balanced' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest, cheapest' },
    { id: 'claude-fable-5-2', label: 'Claude Fable 5.2 — most capable, highest cost' },
  ];

  // Non-secret preferences, kept in chrome.storage.sync so content scripts can
  // read them. The API key and history live in chrome.storage.local, which the
  // service worker restricts to trusted (extension) contexts.
  const DEFAULTS = {
    model: 'claude-opus-5-5',
    defaultMode: 'standard',
    outputLang: 'auto',
    theme: 'auto',
    selectionIcon: true,
    fieldIcon: true,
    saveHistory: true,
    customInstructions: '',
    disabledSites: [],
  };

  const MAX_INPUT_CHARS = 20000;
  const HISTORY_LIMIT = 50;

  function getMode(id) {
    return MODES.find((m) => m.id === id) || MODES[0];
  }

  function normalizeSettings(raw) {
    const s = Object.assign({}, DEFAULTS, raw || {});
    if (!MODELS.some((m) => m.id === s.model)) s.model = DEFAULTS.model;
    if (!MODES.some((m) => m.id === s.defaultMode)) s.defaultMode = DEFAULTS.defaultMode;
    if (s.outputLang !== 'auto' && !LANGUAGES.includes(s.outputLang)) s.outputLang = 'auto';
    if (!['auto', 'light', 'dark'].includes(s.theme)) s.theme = 'auto';
    if (!Array.isArray(s.disabledSites)) s.disabledSites = [];
    s.disabledSites = s.disabledSites.map((h) => String(h).trim().toLowerCase()).filter(Boolean);
    s.customInstructions = String(s.customInstructions || '').slice(0, 1000);
    return s;
  }

  async function loadSettings() {
    const raw = await chrome.storage.sync.get(Object.keys(DEFAULTS));
    return normalizeSettings(raw);
  }

  function countWords(text) {
    const t = String(text || '').trim();
    if (!t) return 0;
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      let n = 0;
      for (const seg of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(t)) {
        if (seg.isWordLike) n++;
      }
      return n;
    }
    return t.split(/\s+/).length;
  }

  root.RP = {
    MODES, LANGUAGES, MODELS, DEFAULTS, MAX_INPUT_CHARS, HISTORY_LIMIT,
    getMode, normalizeSettings, loadSettings, countWords,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
