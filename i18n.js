/**
 * i18n.js
 * Lightweight internationalization module for World Toolkit.
 * Uses localStorage('sv_buddy_lang') as language source (shared with Rocky).
 *
 * Locale files live in JSON:
 *   locales/en.json
 *   locales/tr.json
 */
(function () {
  'use strict';

  var DEFAULT_LANG = 'en';
  var SUPPORTED_LANGS = { en: true, tr: true };
  var LOCALE_FILES = {
    en: 'locales/en.json',
    tr: 'locales/tr.json',
  };
  var strings = {};
  var loadPromises = {};

  function normalizeLang(lang) {
    return SUPPORTED_LANGS[lang] ? lang : DEFAULT_LANG;
  }

  function getLang() {
    if (window.getCurrentLang) return normalizeLang(window.getCurrentLang());
    var lang = localStorage.getItem('sv_buddy_lang');
    if (!lang && navigator.language) lang = navigator.language.split('-')[0];
    return normalizeLang(lang);
  }

  function loadLanguage(lang) {
    lang = normalizeLang(lang);
    if (strings[lang]) return Promise.resolve(strings[lang]);
    if (loadPromises[lang]) return loadPromises[lang];

    loadPromises[lang] = fetch(LOCALE_FILES[lang])
      .then(function (response) {
        if (!response.ok) {
          throw new Error('Failed to load locale "' + lang + '"');
        }
        return response.json();
      })
      .then(function (json) {
        strings[lang] = json;
        return strings[lang];
      });

    return loadPromises[lang];
  }

  function ensureLanguage(lang) {
    return Promise.all([
      loadLanguage(DEFAULT_LANG),
      loadLanguage(lang),
    ]);
  }

  function applyParams(template, params) {
    if (!params) return template;
    Object.keys(params).forEach(function (key) {
      template = template.replace(new RegExp('\\{\\{' + key + '\\}\\}', 'g'), params[key]);
    });
    return template;
  }

  function t(key, params) {
    var lang = getLang();
    var currentStrings = strings[lang] || {};
    var fallbackStrings = strings[DEFAULT_LANG] || {};
    var template = currentStrings[key];
    if (template == null) template = fallbackStrings[key];
    if (template == null) return key;
    if (Array.isArray(template)) return template.slice();
    return applyParams(template, params);
  }

  function applyTranslations() {
    var els = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    }

    var attrEls = document.querySelectorAll('[data-i18n-attr]');
    for (var j = 0; j < attrEls.length; j++) {
      var attrEl = attrEls[j];
      var parts = attrEl.getAttribute('data-i18n-attr').split(/\s*,\s*/);
      for (var k = 0; k < parts.length; k++) {
        var pair = parts[k].split(':');
        if (pair.length === 2) {
          var attrName = pair[0].trim();
          if (attrName === 'title' && attrEl.classList && attrEl.classList.contains('radio-help-tip')) {
            continue;
          }
          attrEl.setAttribute(attrName, t(pair[1].trim()));
        }
      }
    }

    var phEls = document.querySelectorAll('[data-i18n-placeholder]');
    for (var p = 0; p < phEls.length; p++) {
      var phEl = phEls[p];
      var placeholderKey = phEl.getAttribute('data-i18n-placeholder');
      if (placeholderKey) phEl.placeholder = t(placeholderKey);
    }

    var helpTipEls = document.querySelectorAll('.radio-help-tip[title]');
    for (var h = 0; h < helpTipEls.length; h++) {
      helpTipEls[h].removeAttribute('title');
    }

    document.documentElement.lang = getLang();
  }

  function translatePage() {
    var lang = getLang();
    return ensureLanguage(lang).then(function () {
      applyTranslations();
      document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang: lang } }));
      return lang;
    });
  }

  function setLang(lang) {
    lang = normalizeLang(lang);
    localStorage.setItem('sv_buddy_lang', lang);
    return translatePage();
  }

  var ready = ensureLanguage(getLang());

  window.i18n = {
    t: t,
    translatePage: translatePage,
    getLang: getLang,
    setLang: setLang,
    loadLanguage: loadLanguage,
    ready: ready,
    strings: strings,
  };
})();
