(function initCodexOverleafPendingInputView(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafPendingInputView = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function pendingInputViewFactory() {
  'use strict';

  function create(options = {}) {
    const container = options.container;

    function render(items = [], state = {}) {
      if (!container) {
        return;
      }
      container.replaceChildren();
      container.hidden = !items.length;
      if (!items.length) {
        return;
      }
      for (const item of items) {
        const row = document.createElement('article');
        row.className = 'codex-pending-input';
        row.dataset.status = item.status || 'queued';
        const marker = document.createElement('span');
        marker.className = 'codex-pending-input-marker';
        marker.setAttribute('aria-hidden', 'true');
        marker.append(createIcon('queue'));
        const copy = document.createElement('div');
        copy.className = 'codex-pending-input-copy';
        const status = document.createElement('span');
        status.className = 'codex-pending-input-status';
        status.textContent = item.status === 'paused'
          ? options.tr?.('queuedInputPaused')
          : item.status === 'steering'
            ? options.tr?.('queuedInputGuiding')
            : item.status === 'executing'
              ? options.tr?.('queuedInputExecuting')
            : options.tr?.('queuedInputQueued');
        const text = document.createElement('span');
        text.className = 'codex-pending-input-text';
        text.textContent = item.text;
        copy.append(text);
        if (item.status && item.status !== 'queued') {
          copy.append(status);
        }
        const actions = document.createElement('div');
        actions.className = 'codex-pending-input-actions';
        if (item.status === 'paused') {
          actions.append(createButton(options.tr?.('queuedInputResume'), () => options.onResume?.()));
        } else if (state.running && item.status === 'queued') {
          const guide = createIconButton(
            options.tr?.('queuedInputGuide'),
            'guide',
            () => options.onGuide?.(item.id)
          );
          guide.disabled = !state.canGuide;
          guide.title = state.canGuide
            ? options.tr?.('queuedInputGuideTitle')
            : options.tr?.('queuedInputGuideUnavailable');
          actions.append(guide);
        }
        const remove = createIconButton(
          options.tr?.('queuedInputRemove'),
          'remove',
          () => options.onRemove?.(item.id)
        );
        remove.classList.add('codex-pending-input-remove');
        remove.disabled = item.status === 'steering' || item.status === 'executing';
        text.title = item.text;
        actions.append(remove);
        row.setAttribute('aria-label', `${status.textContent || options.tr?.('queuedInputQueued') || 'Queued'}: ${item.text}`);
        row.append(marker, copy, actions);
        container.append(row);
      }
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

  function createIconButton(label, icon, onClick) {
    const button = createButton('', onClick);
    button.className = 'codex-pending-input-icon';
    button.dataset.action = icon;
    button.title = label || '';
    button.setAttribute('aria-label', label || '');
    button.append(createIcon(icon));
    return button;
  }

  function createIcon(icon) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const paths = icon === 'guide'
      ? ['M4 4.5v4a4 4 0 0 0 4 4h7', 'm12 9 3.5 3.5L12 16']
      : icon === 'queue'
        ? ['M4 5.5h12', 'M4 10h12', 'M4 14.5h8']
        : ['M6 6h8', 'M8 6V4.5h4V6', 'm7.2 8 0.6 7.5h4.4l.6-7.5'];
    for (const value of paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', value);
      svg.append(path);
    }
    return svg;
  }

  return { create };
});
