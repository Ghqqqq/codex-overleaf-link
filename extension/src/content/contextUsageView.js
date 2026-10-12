(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('ContextUsageView', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  let nextId = 0;

  // State and ownership are supplied by the runtime. The view never estimates
  // context from conversation text, cumulative billing totals, or model names.
  function create(deps = {}) {
    let state = { usage: null, compacting: false };
    let host = null;
    let button = null;
    let popover = null;
    let panel = null;
    let open = false;
    let observer = null;
    const listeners = [];
    const tr = (key, params) => deps.tr(key, params);

    function bind(target, type, listener, options) {
      if (!target?.addEventListener) return;
      target.addEventListener(type, listener, options);
      listeners.push(() => target.removeEventListener(type, listener, options));
    }

    function unbind() {
      listeners.splice(0).forEach(remove => remove());
      observer?.disconnect();
      observer = null;
    }

    function mount() {
      const currentPanel = deps.getPanel?.();
      const currentHost = currentPanel?.querySelector('[data-context-usage]');
      if (currentHost === host) return Boolean(host);
      unbind();
      host = currentHost || null;
      panel = currentPanel;
      button = host?.querySelector('[data-context-usage-toggle]');
      popover = host?.querySelector('[data-context-usage-popover]');
      open = false;
      if (!button || !popover) return false;
      popover.id = 'codex-context-usage-' + (++nextId);
      button.setAttribute('aria-controls', popover.id);
      const doc = host.ownerDocument;
      const view = doc.defaultView;
      bind(button, 'click', event => {
        event.preventDefault();
        if (open) close();
        else {
          deps.onOpen?.();
          open = true;
          popover.hidden = false;
          button.setAttribute('aria-expanded', 'true');
          position();
        }
      });
      bind(doc, 'pointerdown', event => { if (!host.contains(event.target)) close(); }, true);
      bind(doc, 'focusin', event => { if (!host.contains(event.target)) close(); });
      bind(doc, 'keydown', event => {
        if (open && event.key === 'Escape') {
          const restoreFocus = popover.contains(doc.activeElement);
          close();
          if (restoreFocus) button.focus();
          event.preventDefault();
        }
      });
      bind(view, 'resize', position);
      bind(view?.visualViewport, 'resize', position);
      bind(view?.visualViewport, 'scroll', position);
      bind(doc, 'scroll', position, true);
      if (typeof view?.ResizeObserver === 'function') {
        observer = new view.ResizeObserver(position);
        observer.observe(panel);
        observer.observe(button);
      }
      return true;
    }

    function close() {
      open = false;
      if (popover) popover.hidden = true;
      button?.setAttribute('aria-expanded', 'false');
    }

    function position() {
      if (!open || !popover || !button) return;
      const view = host.ownerDocument.defaultView;
      const viewport = view.visualViewport;
      const viewportLeft = viewport?.offsetLeft || 0;
      const viewportTop = viewport?.offsetTop || 0;
      const viewportRight = viewportLeft + (viewport?.width || view.innerWidth);
      const viewportBottom = viewportTop + (viewport?.height || view.innerHeight);
      const panelRect = panel.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      const left = Math.max(viewportLeft, panelRect.left) + 8;
      const right = Math.min(viewportRight, panelRect.right) - 8;
      const top = Math.max(viewportTop, panelRect.top) + 8;
      const bottom = Math.min(viewportBottom, panelRect.bottom) - 8;
      const width = Math.max(0, Math.min(300, right - left));
      const above = Math.max(0, rect.top - top - 8);
      const below = Math.max(0, bottom - rect.bottom - 8);
      const placeAbove = above >= Math.min(160, below);
      popover.style.width = width + 'px';
      popover.style.maxHeight = Math.max(0, placeAbove ? above : below) + 'px';
      popover.style.left = Math.max(left, Math.min(rect.right - width, right - width)) + 'px';
      const height = popover.getBoundingClientRect().height;
      popover.style.top = (placeAbove ? Math.max(top, rect.top - height - 8) : rect.bottom + 8) + 'px';
    }

    function number(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
      return value;
    }

    function formatTokens(value) {
      if (value === null) return '—';
      const locale = deps.getLocale?.() === 'zh' ? 'zh-CN' : 'en-US';
      const unit = value >= 1e9 ? 1e9 : value >= 1e6 ? 1e6 : value >= 1e3 ? 1e3 : 1;
      const suffix = unit === 1e9 ? 'B' : unit === 1e6 ? 'M' : unit === 1e3 ? 'K' : '';
      return new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 1 ? 0 : 1 }).format(value / unit) + suffix;
    }

    function render() {
      if (!mount()) return;
      const used = number(state.usage?.usedTokens);
      const capacityValue = number(state.usage?.contextWindow);
      const capacity = capacityValue > 0 ? capacityValue : null;
      const percent = used !== null && capacity !== null ? used / capacity * 100 : null;
      const percentage = percent === null ? '—' : new Intl.NumberFormat(
        deps.getLocale?.() === 'zh' ? 'zh-CN' : 'en-US',
        { maximumFractionDigits: 1 }
      ).format(percent) + '%';
      const amount = tr('contextUsageAmount', { used: formatTokens(used), capacity: formatTokens(capacity) });
      const summary = tr('contextUsageSummary', { amount, percentage });
      host.dataset.compacting = state.compacting ? 'true' : 'false';
      host.dataset.unknown = percent === null ? 'true' : 'false';
      host.style.setProperty('--context-usage-percent', String(Math.max(0, Math.min(100, percent || 0))));
      button.title = state.compacting ? tr('contextUsageCompacting') : summary;
      button.setAttribute('aria-label', button.title);
      host.querySelector('[data-context-usage-percent]').textContent = percentage;
      host.querySelector('[data-context-usage-title]').textContent = tr('contextUsageTitle');
      host.querySelector('[data-context-usage-amount]').textContent = amount;
      const note = host.querySelector('[data-context-usage-note]');
      note.textContent = state.compacting ? tr('contextUsageCompacting')
        : used === null ? tr('contextUsageUnavailable')
          : capacity === null ? tr('contextUsageCapacityUnknown') : tr('contextUsageEstimate');
      popover.setAttribute('aria-label', tr('contextUsageTitle'));
      position();
    }

    return {
      setState(value = {}) {
        state = { usage: value.usage || null, compacting: Boolean(value.compacting) };
        render();
      },
      render,
      close,
      destroy() { close(); unbind(); host = button = popover = panel = null; }
    };
  }

  return { create };
});
