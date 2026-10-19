(function initSessionTitle(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafModuleRegistry.define('SessionTitle', [], factory);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function sessionTitleFactory() {
  'use strict';

  const INPUT_LIMIT = 12000;
  const STORAGE_LIMIT = 80;
  const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const FILE_TOKEN = /@file:(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;

  function derive(runs, task, options = {}) {
    let fallback = '';
    for (const run of Array.isArray(runs) ? runs : []) {
      const candidate = fromPrompt(run?.task, options);
      fallback ||= candidate;
      if (candidate && !isGeneric(candidate)) return candidate;
    }
    const draft = fromPrompt(task, options);
    return draft && !isGeneric(draft) ? draft : fallback || draft;
  }

  function fromPrompt(value, { sanitize = text => text, maxChars = 24 } = {}) {
    let title = projectPrompt(value, { sanitize, maxChars });
    // Display titles pass through normalization again on unrelated callbacks.
    // Finish removing nested formatting/prefixes now, before acknowledging a title.
    // The bound guards against an input that never settles.
    for (let pass = 0; pass < 8; pass += 1) {
      const next = projectPrompt(title, { sanitize, maxChars });
      if (next === title) return title;
      title = next;
    }
    return title;
  }

  function projectPrompt(value, { sanitize, maxChars }) {
    if (typeof value !== 'string' || !value.trim()) return '';
    const source = String(sanitize(value.slice(0, INPUT_LIMIT)) || '');
    let fence = null;
    let fallback = '';
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      const marker = /^(`{3,}|~{3,})(.*)$/.exec(line);
      if (marker) {
        if (!fence) {
          fence = marker[1];
          const language = marker[2].trim().match(/^[A-Za-z0-9_+-]{1,24}\b/)?.[0] || 'code';
          fallback ||= `${language} snippet`;
        } else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
          fence = null;
        }
        continue;
      }
      if (fence || !line || /^>/.test(line)) continue;
      const withoutContext = line.replace(FILE_TOKEN, ' ').replace(/@(context|compile-log)\b/g, ' ').trim();
      const cleaned = cleanLine(line);
      if (!withoutContext || /^https?:\/\/\S+$/i.test(line)) {
        fallback ||= cleaned;
        continue;
      }
      for (const sentence of cleaned.split(/[\u3002\uff01\uff1f]+/u)) {
        const candidate = sentence.trim().replace(/[,;:\uff0c\uff1b\uff1a]+$/u, '').trim();
        if (!/[\p{L}\p{N}]/u.test(candidate) || isScaffolding(candidate)) continue;
        fallback ||= candidate;
        if (!isGeneric(candidate)) return shorten(candidate, maxChars);
      }
    }
    return shorten(fallback, maxChars);
  }

  function cleanLine(value) {
    return value
      .replace(/^#{1,6}\s+/, '')
      .replace(/^(?:[-*+]\s+|\d+\.\s+|\d+[)\u3001]\s*)/, '')
      .replace(FILE_TOKEN, (_match, quoted, singleQuoted, bare) =>
        String(quoted || singleQuoted || bare || '').replace(/\\/g, '/').split('/').pop())
      .replace(/@(context|compile-log)\b/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^\n)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/https?:\/\/\S+/gi, address => {
        try { return new URL(address).hostname; } catch (_error) { return ''; }
      })
      .replace(/\[(?:REDACTED_SECRET|local path(?::\d+)?)\]/gi, ' ')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .replace(/\s+/g, ' ').trim()
      .replace(/^(?:(?:\u8bf7(?:\u4f60)?\u5e2e\u6211|\u8bf7\u4f60|\u5e2e\u6211|\u9ebb\u70e6\u4f60(?:\u5e2e\u6211)?|\u9ebb\u70e6\u5e2e\u6211|please\s+)\s*)+/i, '');
  }

  function isScaffolding(value) {
    return /^(?:my request(?: for [^:]+)?|request|task|context|files(?: mentioned by [^:]+)?|attachments|\u6211\u7684\u8bf7\u6c42|\u9700\u6c42|\u4efb\u52a1|\u4e0a\u4e0b\u6587|\u9644\u4ef6|\u6587\u4ef6)$/i.test(value);
  }

  function isGeneric(value) {
    const text = String(value || '').trim().replace(/[\s.!?\u3002\uff1f\uff01\u2026]+$/u, '');
    if (!text || Array.from(text).length < 2) return true;
    return /^(?:ok(?:ay)?|yes|no|go|done|continue|proceed|thanks?|thank you|hello|hi|test|new task|untitled task|\u597d(?:\u7684)?|\u53ef\u4ee5|\u7ee7\u7eed|\u786e\u8ba4|\u786e\u5b9a|\u6536\u5230|\u8c22\u8c22|\u6d4b\u8bd5|\u6267\u884c|\u662f\u7684|\u4f60\u597d)$/i.test(text)
      || /^[A-Za-z0-9_+-]{1,24} snippet$/i.test(text)
      || /^[^\s]+\.(?:tex|bib|md|txt|pdf|svg|png|jpe?g|webp)(?::\d+)?$/i.test(text)
      || /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/i.test(text);
  }

  function shorten(value, maxChars) {
    const title = String(value || '').trim();
    if (!title) return '';
    const chars = Number.isFinite(maxChars) && maxChars > 0 ? Math.min(40, Math.floor(maxChars)) : 24;
    const maxUnits = chars * 2;
    const glyphs = segmenter
      ? Array.from(segmenter.segment(title), item => item.segment) : Array.from(title);
    const width = glyph => /[^\u0000-\u00ff]/u.test(glyph) ? 2 : 1;
    if (title.length <= STORAGE_LIMIT && glyphs.reduce((total, glyph) => total + width(glyph), 0) <= maxUnits) return title;
    let prefix = '';
    let units = 0;
    let index = 0;
    for (; index < glyphs.length; index++) {
      const glyph = glyphs[index];
      if (units + width(glyph) > maxUnits - 2 || prefix.length + glyph.length > STORAGE_LIMIT - 1) break;
      prefix += glyph;
      units += width(glyph);
    }
    const boundary = prefix.lastIndexOf(' ');
    if (/[A-Za-z0-9]$/.test(prefix) && /^[A-Za-z0-9]/.test(glyphs[index] || '') && boundary >= prefix.length * 0.6) {
      prefix = prefix.slice(0, boundary);
    }
    return prefix.trimEnd().replace(/[,;:\uff0c\uff1b\uff1a]+$/u, '') + '\u2026';
  }

  return Object.freeze({ derive, fromPrompt, isGeneric });
});
