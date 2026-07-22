(function initCodexOverleafPanelRenderer() {
  'use strict';

  const ROOT_CLASS = 'codex-overleaf-panel-mounted';
  const RESIZE_CLASS = 'codex-overleaf-panel-resizing';
  const COMPACT_CLASS = 'codex-overleaf-panel-compact';

  function codexIcon(name) {
    const icons = {
      refresh: '<path d="M4.2 5.3A5 5 0 1 1 3.6 10"/><path d="M4.2 2.2v3.1H1.1"/>',
      plus: '<path d="M8 3.2v9.6"/><path d="M3.2 8h9.6"/>',
      settings: '<path d="M3.4 5.2h5.9"/><path d="M11.7 5.2h.9"/><path d="M10.1 3.6v3.2"/><path d="M3.4 10.8h1"/><path d="M6.8 10.8h5.8"/><path d="M5.9 9.2v3.2"/>'
    };
    const safeName = Object.prototype.hasOwnProperty.call(icons, name) ? name : 'settings';
    return `<span class="codex-icon codex-icon-${safeName}" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false">${icons[safeName]}</svg></span>`;
  }

  function create(options = {}) {
    const doc = options.document || document;
    const container = options.container || doc.documentElement;
    const panelEl = doc.createElement('aside');
    const callbacks = options.callbacks || {};
    const instance = {
      panelEl,
      callbacks,
      defaultWidth: options.defaultWidth || 380,
      minWidth: options.minWidth || 340,
      maxWidth: options.maxWidth || 760,
      pageMinWidth: options.pageMinWidth || 520,
      lastDesktopWidth: options.initialWidth || options.defaultWidth || 380,
      listeners: [],
      document: doc,
      window: options.window || window
    };

    panelEl.id = options.panelId || 'codex-overleaf-panel';
    panelEl.dataset.view = 'session';
    panelEl.innerHTML = `
      <div class="codex-panel-resize-handle" data-panel-resize-handle title="Drag to resize the Codex panel. Double click to reset." aria-label="Drag to resize the Codex panel. Double click to reset." role="separator"></div>
      <div class="codex-vscode-head" data-panel-header>
        <div class="codex-vscode-title">CODEX</div>
        <div class="codex-vscode-head-actions" aria-label="Codex actions">
          <button type="button" data-refresh title="Refresh current file status. This will not sync or modify files." aria-label="Refresh current file status. This will not sync or modify files.">${codexIcon('refresh')}</button>
          <div data-diagnostics-slot></div>
          <button type="button" data-new-session title="New Session" aria-label="New Session">${codexIcon('plus')}</button>
          <button type="button" data-custom-instructions-settings title="Project Settings" aria-label="Project Settings" aria-expanded="false">${codexIcon('settings')}</button>
        </div>
      </div>
      <div data-settings-slot></div>
      <div class="codex-vscode-main" data-main>
        <div data-session-slot></div>
        <div class="codex-toast-region" data-toast-region aria-live="polite" aria-atomic="false"></div>
        <section class="codex-thread-section">
          <div class="col-log" data-log></div>
        </section>
      </div>
      <div class="codex-probe-line" data-probe-status>Checking Overleaf state...</div>
      <div data-composer-slot></div>
    `;

    container.append(panelEl);
    doc.documentElement.classList.add(ROOT_CLASS);

    instance.headerEl = panelEl.querySelector('[data-panel-header]');
    instance.bodyEl = panelEl.querySelector('[data-main]');
    instance.diagnosticsSlot = panelEl.querySelector('[data-diagnostics-slot]');
    instance.settingsSlot = panelEl.querySelector('[data-settings-slot]');
    instance.sessionSlot = panelEl.querySelector('[data-session-slot]');
    instance.composerSlot = panelEl.querySelector('[data-composer-slot]');

    bind(instance, panelEl, 'click', event => event.stopPropagation());
    bind(instance, panelEl, 'mousedown', event => event.stopPropagation());
    bind(instance, panelEl.querySelector('[data-refresh]'), 'click', () => callbacks.onRefresh?.());
    bind(instance, panelEl.querySelector('[data-new-session]'), 'click', () => callbacks.onNewSession?.());
    bind(instance, panelEl.querySelector('[data-custom-instructions-settings]'), 'click', () => callbacks.onSettingsClick?.());
    bind(instance, panelEl.querySelector('[data-panel-resize-handle]'), 'pointerdown', event => startResize(instance, event));
    bind(instance, panelEl.querySelector('[data-panel-resize-handle]'), 'dblclick', event => {
      event?.preventDefault?.();
      if (isCompactViewport(instance)) {
        return;
      }
      const width = setWidth(instance, instance.defaultWidth, { notify: false });
      callbacks.onWidthChange?.(width, { persist: true });
    });
    bind(instance, instance.window, 'resize', () => {
      setWidth(instance, instance.lastDesktopWidth || instance.defaultWidth, { notify: true, persist: false });
    });

    setWidth(instance, options.initialWidth || instance.defaultWidth, { notify: false });

    return {
      panelEl,
      headerEl: instance.headerEl,
      bodyEl: instance.bodyEl,
      diagnosticsSlot: instance.diagnosticsSlot,
      settingsSlot: instance.settingsSlot,
      sessionSlot: instance.sessionSlot,
      composerSlot: instance.composerSlot,
      setView: view => { panelEl.dataset.view = view; },
      destroy: () => destroy(instance),
      _instance: instance
    };
  }

  function bind(instance, target, type, listener, options) {
    if (!target?.addEventListener) {
      return;
    }
    target.addEventListener(type, listener, options);
    instance.listeners.push({ target, type, listener, options });
  }

  function startResize(instance, event) {
    if (event.button !== undefined && event.button !== 0) {
      return;
    }
    event.preventDefault();
    if (isCompactViewport(instance)) {
      return;
    }
    const doc = instance.document;
    const startX = event.clientX;
    const startWidth = instance.panelEl?.getBoundingClientRect?.().width || instance.defaultWidth;
    const handle = event.currentTarget;
    let latestWidth = startWidth;

    doc.documentElement.classList.add(RESIZE_CLASS);
    handle?.setPointerCapture?.(event.pointerId);

    const onPointerMove = moveEvent => {
      latestWidth = setWidth(instance, startWidth + (startX - moveEvent.clientX), { notify: false });
    };
    const onPointerUp = () => {
      doc.removeEventListener('pointermove', onPointerMove, true);
      doc.removeEventListener('pointerup', onPointerUp, true);
      doc.documentElement.classList.remove(RESIZE_CLASS);
      instance.callbacks.onWidthChange?.(latestWidth, { persist: true });
    };

    doc.addEventListener('pointermove', onPointerMove, true);
    doc.addEventListener('pointerup', onPointerUp, true);
  }

  function setWidth(target, width, options = {}) {
    const instance = target?._instance || target;
    if (!instance) {
      return 0;
    }
    const nextWidth = clampWidth(instance, width);
    const compact = updateCompactMode(instance);
    instance.document.documentElement.style.setProperty('--codex-overleaf-panel-width', `${nextWidth}px`);
    if (!compact) {
      instance.lastDesktopWidth = nextWidth;
    }
    if (options.notify !== false) {
      instance.callbacks.onWidthChange?.(nextWidth, { persist: !compact && options.persist !== false });
    }
    return nextWidth;
  }

  function clampWidth(instance, width) {
    const viewportWidth = Number(instance.window?.innerWidth);
    if (isCompactViewport(instance)) {
      const overlayMax = Number.isFinite(viewportWidth)
        ? Math.max(240, viewportWidth - 24)
        : instance.minWidth;
      const numericCompactWidth = Number(width);
      const compactWidth = Number.isFinite(numericCompactWidth)
        ? numericCompactWidth
        : instance.lastDesktopWidth || instance.defaultWidth;
      return Math.round(Math.min(instance.maxWidth, overlayMax, Math.max(Math.min(instance.minWidth, overlayMax), compactWidth)));
    }
    const viewportMax = Number.isFinite(viewportWidth)
      ? Math.max(instance.minWidth, viewportWidth - instance.pageMinWidth)
      : instance.maxWidth;
    const maxWidth = Math.min(instance.maxWidth, viewportMax);
    const numericWidth = Number(width);
    if (!Number.isFinite(numericWidth)) {
      return instance.defaultWidth;
    }
    return Math.round(Math.min(maxWidth, Math.max(instance.minWidth, numericWidth)));
  }

  function isCompactViewport(instance) {
    const viewportWidth = Number(instance.window?.innerWidth);
    return Number.isFinite(viewportWidth) && viewportWidth < instance.minWidth + instance.pageMinWidth;
  }

  function updateCompactMode(instance) {
    const compact = isCompactViewport(instance);
    instance.document.documentElement.classList.toggle(COMPACT_CLASS, compact);
    if (!compact) {
      instance.document.documentElement.classList.remove(COMPACT_CLASS);
    }
    return compact;
  }

  function setVisible(panelEl, visible) {
    panelEl?.classList?.toggle('is-open', Boolean(visible));
    document.documentElement.classList.toggle(ROOT_CLASS, Boolean(visible));
    if (!visible) {
      document.documentElement.classList.remove(RESIZE_CLASS, COMPACT_CLASS);
    }
  }

  function setBadge(headerEl, badge = {}) {
    const actions = headerEl?.querySelector?.('.codex-vscode-head-actions');
    if (!actions) {
      return;
    }
    actions.querySelector('[data-panel-header-badge]')?.remove();
    if (!badge || badge.type === 'none') {
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.panelHeaderBadge = badge.type || 'info';
    button.title = badge.tooltip || '';
    button.setAttribute('aria-label', badge.tooltip || badge.type || 'status');
    button.textContent = badge.type === 'update' ? '!' : '?';
    if (typeof badge.onClick === 'function') {
      button.addEventListener('click', badge.onClick);
    }
    actions.prepend(button);
  }

  function createConfirmController(options = {}) {
    let activeResolve = null;

    function isOpen() {
      return Boolean(activeResolve);
    }

    function dismiss(value = false) {
      activeResolve?.(value);
    }

    function show(config = {}) {
      if (!options.getPanel?.()) {
        options.ensurePanelOpen?.();
      }
      const panel = options.getPanel?.();
      if (!panel) {
        return Promise.resolve(false);
      }
      dismiss(false);
      const tr = options.tr || (key => key);
      const title = config.title || tr('confirmDefaultTitle');
      const message = config.message || '';
      const confirmLabel = config.confirmLabel || tr('confirmDefaultConfirm');
      const cancelLabel = config.cancelLabel || tr('confirmDefaultCancel');
      const destructive = config.destructive === true;
      const doc = panel.ownerDocument || document;

      return new Promise(resolve => {
        let settled = false;
        const overlay = doc.createElement('div');
        overlay.className = 'codex-plugin-confirm';
        overlay.setAttribute('data-plugin-confirm', 'true');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', title);

        const card = doc.createElement('section');
        card.className = 'codex-plugin-confirm-card';
        const head = doc.createElement('div');
        head.className = 'codex-plugin-confirm-head';
        const icon = doc.createElement('img');
        icon.className = 'codex-plugin-confirm-icon';
        icon.alt = '';
        icon.setAttribute('aria-hidden', 'true');
        icon.src = options.getIconUrl?.() || '';
        const titleWrap = doc.createElement('div');
        const brand = doc.createElement('div');
        brand.className = 'codex-plugin-confirm-brand';
        brand.textContent = tr('confirmBrand');
        const titleEl = doc.createElement('div');
        titleEl.className = 'codex-plugin-confirm-title';
        titleEl.textContent = title;
        titleWrap.append(brand, titleEl);
        head.append(icon, titleWrap);

        const body = doc.createElement('div');
        body.className = 'codex-plugin-confirm-body';
        body.textContent = String(message);
        const actions = doc.createElement('div');
        actions.className = 'codex-plugin-confirm-actions';
        const cancel = doc.createElement('button');
        cancel.type = 'button';
        cancel.className = 'codex-plugin-confirm-cancel';
        cancel.textContent = cancelLabel;
        const confirm = doc.createElement('button');
        confirm.type = 'button';
        confirm.className = 'codex-plugin-confirm-confirm';
        if (destructive) confirm.dataset.destructive = 'true';
        confirm.textContent = confirmLabel;
        actions.append(cancel, confirm);
        card.append(head, body, actions);
        overlay.append(card);
        panel.append(overlay);

        const cleanup = value => {
          if (settled) return;
          settled = true;
          activeResolve = null;
          doc.removeEventListener('keydown', onKeydown, true);
          overlay.remove();
          resolve(value);
        };
        activeResolve = cleanup;
        const onKeydown = event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cleanup(false);
          } else if (event.key === 'Enter') {
            event.preventDefault();
            if (!destructive && event.target !== cancel) cleanup(true);
            else if (event.target === cancel) cleanup(false);
            else if (event.target === confirm) cleanup(true);
          } else if (event.key === 'Tab') {
            event.preventDefault();
            (event.target === cancel ? confirm : cancel).focus();
          }
        };
        overlay.addEventListener('click', event => {
          if (event.target === overlay) cleanup(false);
        });
        cancel.addEventListener('click', () => cleanup(false));
        confirm.addEventListener('click', () => cleanup(true));
        doc.addEventListener('keydown', onKeydown, true);
        (destructive ? cancel : confirm).focus();
      });
    }

    return { dismiss, isOpen, show };
  }

  function destroy(instance) {
    for (const { target, type, listener, options } of instance.listeners.splice(0)) {
      target.removeEventListener?.(type, listener, options);
    }
    instance.panelEl?.remove?.();
    instance.document.documentElement.classList.remove(ROOT_CLASS, RESIZE_CLASS, COMPACT_CLASS);
  }

  window.CodexOverleafPanelRenderer = {
    create,
    createConfirmController,
    setVisible,
    setBadge,
    setWidth
  };
})();
