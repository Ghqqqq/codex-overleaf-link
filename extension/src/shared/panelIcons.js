(function initPanelIcons(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('PanelIcons', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function panelIconsFactory() {
  'use strict';

  // 16-unit line icons drawn in the panel header's codexIcon style. Size and
  // color come from the caller; `.codex-glyph` supplies stroke and caps.
  const PATHS = Object.freeze({
    plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
    send: '<path d="M8 12.8V3.6"/><path d="m4.2 7.4 3.8-3.8 3.8 3.8"/>',
    stop: '<rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.6" fill="currentColor" stroke="none"/>',
    attach: '<path d="m12.6 7.4-4.8 4.8a3 3 0 0 1-4.2-4.2l5-5a2 2 0 0 1 2.8 2.8l-4.9 4.9a1 1 0 0 1-1.4-1.4l4.4-4.4"/>',
    refresh: '<path d="M4.2 5.3A5 5 0 1 1 3.6 10"/><path d="M4.2 2.2v3.1H1.1"/>',
    sparkle: '<path d="M7.4 2.6c.5 2.6 1.8 3.9 4.4 4.4-2.6.5-3.9 1.8-4.4 4.4C6.9 8.8 5.6 7.5 3 7c2.6-.5 3.9-1.8 4.4-4.4Z"/><path d="M12.3 10.5c.2 1 .7 1.5 1.7 1.7-1 .2-1.5.7-1.7 1.7-.2-1-.7-1.5-1.7-1.7 1-.2 1.5-.7 1.7-1.7Z"/>',
    close: '<path d="m4.6 4.6 6.8 6.8M11.4 4.6l-6.8 6.8"/>',
    pencil: '<path d="M10.4 3.1 12.9 5.6 6 12.5l-3.1.6.6-3.1Z"/><path d="m9.2 4.3 2.5 2.5"/>',
    chevronDown: '<path d="m4.4 6.4 3.6 3.6 3.6-3.6"/>',
    chevronLeft: '<path d="m9.8 3.6-4.4 4.4 4.4 4.4"/>',
    lock: '<rect x="3.6" y="7.1" width="8.8" height="6.3" rx="1.5"/><path d="M5.6 7.1V5.3a2.4 2.4 0 0 1 4.8 0v1.8"/>',
    compact: '<path d="M4.6 2.4 8 5.6l3.4-3.2"/><path d="M4.6 13.6 8 10.4l3.4 3.2"/><path d="M2.6 8h10.8"/>',
    install: '<path d="M8 2.4v7.4"/><path d="m4.8 6.8 3.2 3.2 3.2-3.2"/><path d="M2.6 11v1.5c0 .6.4 1 1 1h8.8c.6 0 1-.4 1-1V11"/>',
    book: '<path d="M8 4.3c-1.3-1.1-3-1.5-5.2-1.4v9.3c2.2-.1 3.9.3 5.2 1.4 1.3-1.1 3-1.5 5.2-1.4V2.9C11 2.8 9.3 3.2 8 4.3Z"/><path d="M8 4.3v9.3"/>',
    terminal: '<rect x="2.1" y="2.9" width="11.8" height="10.2" rx="2"/><path d="m5 6.4 2 1.7-2 1.7"/><path d="M8.7 10h2.5"/>',
    file: '<path d="M9.2 2.4H4.6a1 1 0 0 0-1 1v9.2a1 1 0 0 0 1 1h6.8a1 1 0 0 0 1-1V5.6Z"/><path d="M9.2 2.4v3.2h3.2"/>',
    folder: '<path d="M2.2 4.4a1 1 0 0 1 1-1h3l1.4 1.6h5.2a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1Z"/>',
    alert: '<circle cx="8" cy="8" r="5.9"/><path d="M8 5v3.5"/><path d="M8 11h.01"/>',
    spin: '<path d="M13.6 8A5.6 5.6 0 1 1 8 2.4"/>'
  });

  function svg(name, className = '') {
    const paths = PATHS[name];
    if (!paths) return '';
    return '<svg class="codex-glyph' + (className ? ' ' + className : '') + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
      + paths + '</svg>';
  }

  return { svg };
});
