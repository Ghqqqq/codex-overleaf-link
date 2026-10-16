(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('ContextUsageView', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  let nextId = 0;

  // State and ownership are supplied by the runtime. The view never estimates
  // context from conversation text, cumulative billing totals, or model names.
  function create(deps = {}) {
    let state = { usage: null, compacting: false, compactingKind: '', pending: false, compacted: false };
    let host = null;
    let button = null;
    let popover = null;
    let compactButton = null;
    let panel = null;
    let open = false;
    let observer = null;
    const listeners = [];
    const tr = (key, params) => deps.tr(key, params);
    const locale = () => deps.getLocale?.() === 'zh' ? 'zh-CN' : 'en-US';

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
      compactButton = host?.querySelector('[data-context-usage-compact]');
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
          render();
        }
      });
      bind(compactButton, 'click', event => {
        event.preventDefault();
        if (compactButton.disabled) return;
        close();
        deps.onCompact?.();
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
      const width = Math.max(0, Math.min(284, right - left));
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
      const unit = value >= 1e9 ? 1e9 : value >= 1e6 ? 1e6 : value >= 1e3 ? 1e3 : 1;
      const suffix = unit === 1e9 ? 'B' : unit === 1e6 ? 'M' : unit === 1e3 ? 'K' : '';
      return new Intl.NumberFormat(locale(), { maximumFractionDigits: unit === 1 ? 0 : 1 }).format(value / unit) + suffix;
    }

    function formatPercent(value, digits = 1) {
      return value === null ? '—' : new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: digits }).format(value);
    }

    function formatLatestReply(value) {
      const at = Date.parse(value || '');
      if (!Number.isFinite(at)) return '';
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
      const minutes = Math.round(seconds / 60), hours = Math.round(minutes / 60), days = Math.round(hours / 24);
      const time = seconds < 45 ? tr('contextUsageJustNow')
        : minutes < 60 ? tr('contextUsageMinutesAgo', { count: Math.max(1, minutes) })
          : hours < 24 ? tr('contextUsageHoursAgo', { count: hours })
            : tr(days === 1 ? 'contextUsageDayAgo' : 'contextUsageDaysAgo', { count: days });
      return tr('contextUsageLatestReply', { time });
    }

    function text(name, value) {
      const node = host.querySelector('[data-context-usage-' + name + ']');
      if (node) node.textContent = value;
      return node;
    }

    // The bar spans the reported window; its filled part splits by the latest
    // response's counters. Cached input is drawn inside input, never added to it.
    function renderBreakdown(used, capacity) {
      const input = number(state.usage?.inputTokens), output = number(state.usage?.outputTokens);
      const cachedValue = number(state.usage?.cachedInputTokens);
      const cached = input !== null && cachedValue !== null && cachedValue <= input ? cachedValue : null;
      const total = input !== null && output !== null && Number.isSafeInteger(input + output)
        && input + output > 0 ? input + output : null;
      const filled = used !== null && capacity !== null ? Math.min(1, used / capacity) : 0;
      const widths = total === null
        ? { cached: 0, input: filled, output: 0 }
        : { cached: filled * (cached || 0) / total, input: filled * (input - (cached || 0)) / total, output: filled * output / total };
      for (const [name, width] of Object.entries(widths)) {
        const node = host.querySelector('[data-context-usage-bar] [data-seg="' + name + '"]');
        if (node) node.style.width = (width * 100).toFixed(3) + '%';
      }
      const legend = host.querySelector('[data-context-usage-breakdown]');
      legend.hidden = input === null && output === null;
      text('input-label', tr('contextUsageInput'));
      text('output-label', tr('contextUsageOutput'));
      text('cached-label', tr('contextUsageCacheHit'));
      text('input', formatTokens(input));
      text('output', formatTokens(output));
      text('cached', formatTokens(cached));
      text('input-share', total === null ? '' : formatPercent(input / total, 0));
      text('output-share', total === null ? '' : formatPercent(output / total, 0));
      const rate = text('cache-rate', input > 0 && cached !== null ? formatPercent(cached / input, 0) : '—');
      if (rate) rate.title = tr('contextUsageCacheHitRate');
      legend.title = total === null ? '' : tr('contextUsageBreakdownBasis');
      host.querySelector('[data-context-usage-cache]').hidden = input === null || cached === null;
    }

    function render() {
      if (!mount()) return;
      const used = number(state.usage?.usedTokens);
      const capacityValue = number(state.usage?.contextWindow);
      const capacity = capacityValue > 0 ? capacityValue : null;
      const percent = used !== null && capacity !== null ? used / capacity * 100 : null;
      const level = percent === null ? '' : deps.level?.(percent) || 'normal';
      const percentage = percent === null ? '' : new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(percent);
      const amount = tr('contextUsageAmount', { used: formatTokens(used), capacity: formatTokens(capacity) });
      const summary = tr('contextUsageSummary', { amount, percentage: percent === null ? '—' : percentage + '%' });
      const compactingText = state.compactingKind === 'auto' ? tr('contextUsageCompactingAuto') : tr('contextUsageCompacting');
      const compacting = state.compacting;
      const pending = !compacting && state.pending;
      const availability = deps.getCompactAvailability?.() || { ok: true };
      // No sample and nothing in progress: show the empty state. Before the first
      // message there is no thread, so the line says when usage will appear.
      const empty = used === null && !compacting && !pending;
      const noThread = availability.ok === false && availability.reason === 'compactNoThread';
      const emptyText = noThread ? tr('contextUsageBeforeFirstMessage') : tr('contextUsageUnavailable');
      host.dataset.compacting = compacting ? 'true' : 'false';
      host.dataset.empty = empty ? 'true' : 'false';
      host.dataset.unknown = percent === null ? 'true' : 'false';
      host.dataset.pending = pending ? 'true' : 'false';
      host.dataset.level = level;
      host.style.setProperty('--context-usage-percent', String(Math.max(0, Math.min(100, percent || 0))));
      button.title = compacting ? compactingText : pending ? tr(state.compacted ? 'contextUsagePending' : 'contextUsagePendingDetail')
        : used === null ? emptyText : summary;
      button.setAttribute('aria-label', button.title);
      text('title', tr('contextUsageTitle'));
      // Without a usable sample, the line under the title carries the state.
      text('amount', used !== null ? amount : compacting ? compactingText
        : pending ? tr('contextUsagePendingDetail') : emptyText);
      host.querySelector('[data-context-usage-spinner]').hidden = !compacting;
      const chip = text('chip', tr('contextUsageCompactedChip'));
      if (chip) chip.hidden = !pending || !state.compacted;
      host.querySelector('[data-context-usage-percent-wrap]').hidden = compacting || pending;
      text('percent', percent === null ? '—' : percentage);
      host.querySelector('[data-context-usage-percent-sign]').hidden = percent === null;
      const figure = host.querySelector('[data-context-usage-figure]');
      if (figure) figure.title = percent === null ? '' : tr('contextUsageEstimate');
      const levelNode = text('level', level === 'near-limit' ? tr('contextUsageNearLimit') : level === 'high' ? tr('contextUsageHigh') : '');
      if (levelNode) levelNode.hidden = compacting || (level !== 'high' && level !== 'near-limit');
      // A sample shown while compacting gets an explicit note; so does a missing capacity.
      const noteText = used === null ? '' : compacting ? compactingText : capacity === null ? tr('contextUsageCapacityUnknown') : '';
      text('note-text', noteText);
      const note = host.querySelector('[data-context-usage-note]');
      if (note) {
        note.hidden = !noteText;
        note.dataset.kind = compacting ? 'compacting' : 'info';
      }
      renderBreakdown(used, capacity);
      const reported = text('reported', used === null ? '' : formatLatestReply(state.usage?.observedAt));
      if (reported) reported.hidden = !reported.textContent;
      if (compactButton) {
        // Without a conversation there is nothing to compact; a busy state keeps the disabled button.
        compactButton.hidden = noThread;
        compactButton.disabled = availability.ok === false;
        compactButton.title = availability.ok === false ? tr(availability.reason || 'compactBusy') : tr('contextUsageCompactHint');
        text('compact-label', tr('contextUsageCompactAction'));
      }
      const foot = host.querySelector('[data-context-usage-foot]');
      if (foot) foot.hidden = (!compactButton || compactButton.hidden) && (!reported || reported.hidden);
      popover.setAttribute('aria-label', tr('contextUsageTitle'));
      position();
    }

    return {
      setState(value = {}) {
        state = { usage: value.usage || null, compacting: Boolean(value.compacting),
          compactingKind: value.compactingKind || '', pending: Boolean(value.pending), compacted: Boolean(value.compacted) };
        render();
      },
      render,
      close,
      destroy() { close(); unbind(); host = button = popover = compactButton = panel = null; }
    };
  }

  return { create };
});
