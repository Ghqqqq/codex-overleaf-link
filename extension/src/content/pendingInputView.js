(function initCodexOverleafPendingInputView(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafPendingInputView = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function pendingInputViewFactory() {
  'use strict';

  // Queued follow-ups render as one card docked on top of the composer:
  // a header that says what will happen, the first message (two lines),
  // "N more queued", a labelled Steer action and a hover-only remove.
  const ICONS = {
    clock: ['M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Z', 'M8 5v3l2 1.4'],
    pause: ['M6 4.5v7', 'M10 4.5v7'],
    guide: ['M3.2 3.6v3.2a3.2 3.2 0 0 0 3.2 3.2H12', 'm9.6 7.2 2.8 2.8-2.8 2.8'],
    remove: ['m4.5 4.5 7 7', 'm11.5 4.5-7 7']
  };

  function create(options = {}) {
    const container = options.container;
    const tr = (key, params) => options.tr?.(key, params) || '';
    let expanded = false;

    function headerState(items) {
      if (items.some(item => item.status === 'steering')) return { state: 'steering', icon: 'guide', label: tr('queuedInputSteering') };
      if (items.some(item => item.status === 'paused')) return { state: 'paused', icon: 'pause', label: tr('queuedInputPaused') };
      if (items.some(item => item.status === 'executing')) return { state: 'executing', icon: 'clock', label: tr('queuedInputExecuting') };
      return { state: 'queued', icon: 'clock', label: tr(items.length > 1 ? 'queuedInputUpNextMany' : 'queuedInputUpNext') };
    }

    function render(items = [], state = {}) {
      if (!container) return;
      container.replaceChildren();
      container.hidden = !items.length;
      if (!items.length) { expanded = false; return; }
      const head = headerState(items);
      container.dataset.state = head.state;
      const header = document.createElement('header');
      header.className = 'codex-pending-head';
      const label = document.createElement('span');
      label.className = 'codex-pending-head-label';
      label.textContent = head.label;
      header.append(createIcon(head.icon), label);
      if (items.length > 1) {
        const count = document.createElement('span');
        count.className = 'codex-pending-count';
        count.textContent = String(items.length);
        header.append(count);
      }
      if (head.state === 'paused') {
        const resume = createButton(tr('queuedInputResume'), () => options.onResume?.());
        resume.className = 'codex-pending-resume';
        header.append(resume);
      }
      const list = document.createElement('ol');
      list.className = 'codex-pending-list';
      const visible = expanded ? items : items.slice(0, 1);
      visible.forEach((item, index) => list.append(renderItem(item, index, items.length, state, head.state)));
      container.append(header, list);
      if (items.length > 1) {
        const more = createButton(expanded ? tr('queuedInputShowLess') : tr('queuedInputMore', { count: String(items.length - 1) }),
          () => { expanded = !expanded; render(items, state); });
        more.className = 'codex-pending-more';
        more.setAttribute('aria-expanded', String(expanded));
        container.append(more);
      }
      if (state.running && !state.canGuide && head.state === 'queued') {
        const hint = document.createElement('p');
        hint.className = 'codex-pending-hint';
        hint.textContent = tr('queuedInputGuideHint');
        container.append(hint);
      }
    }

    function renderItem(item, index, total, state, headState) {
      const row = document.createElement('li');
      row.className = 'codex-pending-input';
      row.dataset.status = item.status || 'queued';
      const number = document.createElement('span');
      number.className = 'codex-pending-number';
      number.textContent = total > 1 ? String(index + 1) : '';
      const text = document.createElement('button');
      text.type = 'button';
      text.className = 'codex-pending-input-text';
      text.textContent = item.text;
      const editable = (item.status || 'queued') === 'queued';
      text.title = editable ? tr('queuedInputEdit') : item.text;
      text.disabled = !editable;
      text.addEventListener('click', () => pullBack(item));
      const actions = document.createElement('span');
      actions.className = 'codex-pending-input-actions';
      if (index === 0 && state.running && item.status === 'queued' && headState === 'queued') {
        const guide = createButton('', () => options.onGuide?.(item.id));
        guide.className = 'codex-pending-steer';
        guide.dataset.action = 'guide';
        guide.append(createIcon('guide'), Object.assign(document.createElement('span'), { textContent: tr('queuedInputGuide') }));
        guide.disabled = !state.canGuide;
        guide.title = state.canGuide ? tr('queuedInputGuideTitle') : tr('queuedInputGuideUnavailable');
        actions.append(guide);
      }
      const remove = createButton('', () => options.onRemove?.(item.id));
      remove.className = 'codex-pending-input-remove';
      remove.dataset.action = 'remove';
      remove.title = tr('queuedInputRemove');
      remove.setAttribute('aria-label', remove.title);
      remove.append(createIcon('remove'));
      remove.disabled = item.status === 'steering' || item.status === 'executing';
      actions.append(remove);
      row.setAttribute('aria-label', `${tr('queuedInputQueued') || 'Queued'}: ${item.text}`);
      row.append(number, text, actions);
      return row;
    }

    // Pull a queued message back into the composer. A typed draft is never overwritten.
    function pullBack(item) {
      const task = container?.parentElement?.querySelector('[data-task]');
      if (!task || (item.status || 'queued') !== 'queued') return;
      if (String(task.value || '').trim()) { options.onToast?.(tr('queuedInputEditBlocked')); return; }
      options.onRemove?.(item.id);
      task.value = item.text;
      task.dispatchEvent(new Event('input', { bubbles: true }));
      task.focus();
      task.setSelectionRange?.(task.value.length, task.value.length);
    }

    return { render };
  }

  function createButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label || '';
    button.addEventListener('click', onClick);
    return button;
  }

  function createIcon(icon) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const value of ICONS[icon] || ICONS.clock) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', value);
      svg.append(path);
    }
    return svg;
  }

  return { create };
});
