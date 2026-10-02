(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../shared/selectionContext'));
  else root.CodexOverleafModuleRegistry.define('SelectionContextView', ['SelectionContext'], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function (SelectionContext) {
  'use strict';

  // The chip shared by the composer and sent messages: file:lines, the edit-only
  // scope label, and the selected text behind a disclosure.
  function buildChip(selection, { document: doc = globalThis.document, tx = en => en, expanded = false } = {}) {
    const lines = selection.lineStart === selection.lineEnd
      ? String(selection.lineStart) : selection.lineStart + '-' + selection.lineEnd;
    const location = selection.path + ':' + lines;
    const details = doc.createElement('details');
    details.open = expanded;
    const summary = doc.createElement('summary');
    summary.title = location;
    summary.setAttribute('aria-label', tx('Preview selection from ' + location, '预览选区：' + location));
    const file = doc.createElement('span');
    file.className = 'codex-selection-file';
    file.textContent = selection.path.split('/').pop();
    const range = doc.createElement('span');
    range.className = 'codex-selection-range';
    range.textContent = ':' + lines;
    summary.append(file, range);
    if (selection.mode === 'edit') {
      const scope = doc.createElement('span');
      scope.className = 'codex-selection-scope';
      scope.textContent = tx('Selection only', '仅此处');
      summary.append(scope);
    }
    const source = doc.createElement('pre');
    source.textContent = selection.text;
    details.append(summary, source);
    return details;
  }

  // Read-only chip for a sent message: the selection travels with the run's
  // execution snapshot, so the bubble keeps showing what was attached.
  function renderSent(host, value, options = {}) {
    if (!host) return;
    const selection = SelectionContext.normalize(value);
    host.replaceChildren();
    host.hidden = !selection;
    if (selection) host.append(buildChip(selection, options));
  }

  function create(deps = {}) {
    let generation = 0;
    let probeGeneration = 0;
    let timer = null;
    let controller = null;
    let toolbar = null;
    let candidate = null;
    let pointerSelecting = false;
    let pointerEditor = null;
    const resetEvent = 'codex-overleaf-selection-ui-reset';
    const tx = (en, zh) => deps.tx ? deps.tx(en, zh) : en;

    function capture() {
      const selection = SelectionContext.normalize(deps.getState()?.selectionContext);
      return selection?.projectId === deps.getProjectId() ? selection : null;
    }

    function clear() {
      generation += 1;
      hideFloating();
      deps.setSelection(null);
      render();
    }

    function render() {
      const panel = deps.getPanel();
      if (toolbar && !toolbar.hidden) syncFloatingAppearance();
      const host = panel?.querySelector('[data-composer-selection]');
      if (!host) return;
      const selection = capture();
      const id = selection ? [selection.projectId, selection.path, selection.from, selection.to,
        selection.documentHash, selection.capturedAt, selection.mode].join(':') : '';
      const expanded = Boolean(id && host.dataset.selectionId === id && host.querySelector('details')?.open);
      host.replaceChildren();
      host.dataset.selectionId = id;
      host.hidden = !selection;
      if (!selection) return;

      host.append(buildChip(selection, { document, tx, expanded }));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '\u00d7';
      remove.title = tx('Remove selection', '移除选区');
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', clear);
      host.append(remove);
    }

    async function attach(mode = 'reference', selected = null) {
      const request = ++generation;
      const projectId = deps.getProjectId();
      const sessionId = deps.getState()?.activeSessionId;
      if (selected && (selected.projectId !== projectId || selected.sessionId !== sessionId)) return null;
      hideFloating();
      try {
        const response = selected
          ? { ok: true, selection: selected.selection }
          : await deps.callPageBridge('getSelectionContext', { runProjectId: projectId });
        if (request !== generation || projectId !== deps.getProjectId()
          || sessionId !== deps.getState()?.activeSessionId) return null;
        const selection = SelectionContext.normalize({
          ...(response?.selection || response), mode: mode === 'edit' ? 'edit' : 'reference'
        });
        if (response?.ok !== true || !selection || selection.projectId !== projectId) {
          deps.toast?.(response?.code === 'selection_too_large'
            ? tx('Select a shorter passage (up to 20,000 characters).', '请选择较短的片段，最多 20,000 个字符。')
            : tx('Select text in the source editor first.', '请先在源码编辑器中选中文字。'));
          return null;
        }
        await deps.openComposer?.();
        if (request !== generation || projectId !== deps.getProjectId()
          || sessionId !== deps.getState()?.activeSessionId) return null;
        deps.setSelection(selection, { edit: selection.mode === 'edit' });
        render();
        const panel = deps.getPanel();
        const tray = panel?.querySelector('[data-context-tray]');
        if (tray) tray.hidden = true;
        panel?.querySelector('[data-add-context]')?.setAttribute('aria-expanded', 'false');
        panel?.querySelector('[data-task]')?.focus();
        return selection;
      } catch (_) {
        if (request === generation && projectId === deps.getProjectId()
          && sessionId === deps.getState()?.activeSessionId) {
          deps.toast?.(tx('Could not attach the selection. Select it again and retry.', '未能添加选区，请重新选取后再试。'));
        }
        return null;
      }
    }

    function editorFor(node) {
      const element = node?.nodeType === 1 ? node : node?.parentElement;
      const editor = element?.closest?.('.cm-editor');
      return editor && !editor.closest('#codex-overleaf-panel') ? editor : null;
    }

    function hideFloating() {
      probeGeneration += 1;
      clearTimeout(timer);
      timer = null;
      candidate = null;
      if (!toolbar) return;
      if (typeof toolbar.hidePopover === 'function' && toolbar.matches(':popover-open')) toolbar.hidePopover();
      toolbar.hidden = true;
    }

    function syncFloatingAppearance() {
      if (!toolbar) return;
      const panel = deps.getPanel();
      const computed = panel ? window.getComputedStyle(panel) : null;
      const theme = deps.getState()?.theme;
      const dark = theme === 'dark' || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      const colors = dark
        ? ['#26282b', '#f1f2f4', '#adb4be', '#454b53', '#353a41', '#91b7e1']
        : ['#ffffff', '#24292f', '#67717e', '#d8dde3', '#f0f3f6', '#2f73b8'];
      ['--tl-surface-0', '--tl-fg-1', '--tl-fg-3', '--tl-border-strong', '--tl-hover', '--tl-accent']
        .forEach((name, index) => toolbar.style.setProperty(name, computed?.getPropertyValue(name).trim() || colors[index]));
      if (computed?.fontFamily) toolbar.style.fontFamily = computed.fontFamily;
      toolbar.setAttribute('aria-label', tx('Selected text actions', '选区操作'));
      toolbar.querySelector('[data-selection-action="reference"]').textContent = tx('Add to Chat', '加入对话');
      toolbar.querySelector('[data-selection-action="edit"]').textContent = tx('Edit Selection', '仅编辑此处');
    }

    function ensureToolbar() {
      if (toolbar) return;
      toolbar = document.createElement('div');
      toolbar.className = 'codex-selection-actions';
      toolbar.setAttribute('data-codex-selection-actions', '');
      toolbar.setAttribute('role', 'toolbar');
      toolbar.hidden = true;
      if (typeof toolbar.showPopover === 'function') toolbar.setAttribute('popover', 'manual');
      for (const mode of ['reference', 'edit']) {
        if (mode === 'edit') {
          const divider = document.createElement('span');
          divider.className = 'codex-selection-action-divider';
          divider.setAttribute('aria-hidden', 'true');
          toolbar.append(divider);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.selectionAction = mode;
        button.addEventListener('click', () => {
          const selected = candidate;
          if (selected) void attach(mode, selected);
        });
        toolbar.append(button);
      }
      document.body.append(toolbar);
      syncFloatingAppearance();
    }

    function showFloating(anchor) {
      ensureToolbar();
      syncFloatingAppearance();
      toolbar.hidden = false;
      if (typeof toolbar.showPopover === 'function' && !toolbar.matches(':popover-open')) toolbar.showPopover();
      const rect = toolbar.getBoundingClientRect();
      const width = window.innerWidth, height = window.innerHeight;
      const left = Math.max(8, Math.min(width - rect.width - 8,
        (anchor.left + anchor.right) / 2 - rect.width / 2));
      const preferredTop = anchor.top - rect.height - 8;
      const top = Math.max(8, Math.min(height - rect.height - 8,
        preferredTop >= 8 ? preferredTop : anchor.bottom + 8));
      toolbar.style.left = left + 'px';
      toolbar.style.top = top + 'px';
    }

    function schedule(editor) {
      hideFloating();
      if (!controller || pointerSelecting || !editor) return;
      const request = ++probeGeneration;
      timer = setTimeout(() => { timer = null; void probe(editor, request); }, 90);
    }

    async function probe(editor, request) {
      if (!controller || request !== probeGeneration || document.hidden
        || !editor.isConnected || !editor.contains(document.activeElement)) return;
      const projectId = deps.getProjectId();
      const sessionId = deps.getState()?.activeSessionId;
      try {
        const response = await deps.callPageBridge('getSelectionContext', { runProjectId: projectId });
        if (request !== probeGeneration || projectId !== deps.getProjectId()
          || sessionId !== deps.getState()?.activeSessionId || !editor.isConnected
          || !editor.contains(document.activeElement)) return;
        const selection = SelectionContext.normalize(response?.selection || response);
        const anchor = response?.anchor;
        if (!response?.ok || !selection || selection.projectId !== projectId || !anchor
          || !['left', 'right', 'top', 'bottom'].every(key => Number.isFinite(anchor[key]))
          || anchor.bottom < 0 || anchor.top > window.innerHeight) return;
        candidate = { selection, anchor, projectId, sessionId };
        showFloating(anchor);
      } catch (_) { /* Transient editor states do not interrupt ordinary selection. */ }
    }

    function start() {
      if (controller) return;
      // Replacing a content runtime retires the old selection listener set.
      document.dispatchEvent(new Event(resetEvent));
      controller = new AbortController();
      const options = { capture: true, signal: controller.signal };
      document.addEventListener(resetEvent, destroy, options);
      document.addEventListener('pointerdown', event => {
        if (toolbar?.contains(event.target)) {
          if (event.button === 0) event.preventDefault();
          return;
        }
        hideFloating();
        pointerEditor = editorFor(event.target);
        pointerSelecting = Boolean(pointerEditor && event.button === 0);
      }, options);
      document.addEventListener('pointerup', () => {
        if (!pointerSelecting) return;
        pointerSelecting = false;
        const editor = pointerEditor;
        pointerEditor = null;
        schedule(editor);
      }, options);
      document.addEventListener('pointercancel', () => {
        pointerSelecting = false;
        pointerEditor = null;
        hideFloating();
      }, options);
      document.addEventListener('selectionchange', () => {
        if (pointerSelecting || toolbar?.contains(document.activeElement)) return;
        schedule(editorFor(document.activeElement));
      }, options);
      document.addEventListener('keyup', event => {
        if (event.key !== 'Escape' && editorFor(event.target)) schedule(editorFor(event.target));
      }, options);
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') hideFloating();
      }, options);
      document.addEventListener('scroll', hideFloating, { ...options, passive: true });
      document.addEventListener('visibilitychange', () => { if (document.hidden) hideFloating(); }, options);
      window.addEventListener('resize', hideFloating, { ...options, passive: true });
      window.addEventListener('blur', hideFloating, options);
      window.addEventListener('pagehide', event => { if (event.persisted) hideFloating(); else destroy(); }, options);
    }

    function destroy() {
      generation += 1;
      hideFloating();
      controller?.abort();
      controller = null;
      pointerSelecting = false;
      pointerEditor = null;
      toolbar?.remove();
      toolbar = null;
    }

    return { attach, capture, clear, render, start, destroy };
  }

  return { create, buildChip, renderSent };
});
