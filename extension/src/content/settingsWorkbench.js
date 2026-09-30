(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('SettingsWorkbench', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CATEGORIES = [
    ['general', 'settingsWorkbenchGeneral', 'appearance'],
    ['providers', 'settingsWorkbenchModels', 'bolt'],
    ['context', 'settingsWorkbenchContext', 'database'],
    ['instructions', 'settingsWorkbenchInstructions', 'pen'],
    ['protection', 'settingsWorkbenchProtection', 'shield'],
    ['history', 'settingsWorkbenchHistory', 'history'],
    ['updates', 'softwareUpdatesTitle', 'software']
  ];
  const GROUP_PAGES = {
    appearance: 'general', 'writing-style': 'general', providers: 'providers', 'context-loading': 'context',
    experimental: 'context', personalization: 'instructions', protection: 'protection',
    privacy: 'protection', history: 'history', storage: 'history', updates: 'updates'
  };
  const PROJECT_GROUPS = new Set(['writing-style', 'personalization', 'protection', 'privacy', 'experimental', 'history']);

  function mount(instance, options = {}) {
    const container = instance.container, doc = container.ownerDocument;
    const panel = container.closest('#codex-overleaf-panel');
    const settings = container.querySelector('[data-project-settings-panel]');
    const skills = container.querySelector('.codex-skills-panel');
    if (!panel || !settings || !doc) return null;
    const win = doc.defaultView;
    const t = key => instance.i18n?.tr?.(key) || key;
    const listeners = [];
    const listen = (node, name, listener, eventOptions) => {
      node?.addEventListener(name, listener, eventOptions);
      listeners.push(() => node?.removeEventListener(name, listener, eventOptions));
    };
    const make = (tag, className, key) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (key) { node.dataset.i18n = key; node.textContent = t(key); }
      return node;
    };
    const button = (className, key) => {
      const node = make('button', className, key);
      node.type = 'button';
      return node;
    };
    const originalHead = settings.querySelector('.codex-custom-instructions-head');
    const closeButton = originalHead?.querySelector('[data-settings-back]')
      || button('', 'settingsWorkbenchClose');
    const status = settings.querySelector('[data-project-settings-status]');
    const dialog = make('dialog', 'codex-settings-workbench');
    dialog.setAttribute('aria-labelledby', 'codex-settings-workbench-title');
    const header = make('header', 'codex-wb-header');
    const heading = make('div', 'codex-wb-heading');
    const title = make('h2', '', 'settingsWorkbenchTitle');
    title.id = 'codex-settings-workbench-title';
    heading.append(title, make('p', '', 'settingsWorkbenchSubtitle'));
    closeButton.classList.add('codex-wb-close');
    closeButton.textContent = '\u00d7';
    header.append(heading, closeButton);
    originalHead?.remove();

    const layout = make('div', 'codex-wb-layout');
    const sidebar = make('aside', 'codex-wb-sidebar');
    const filters = make('div', 'codex-wb-filters');
    filters.setAttribute('role', 'group');
    const allFilter = button('', 'settingsWorkbenchAll');
    const projectFilter = button('', 'settingsScopeProjectTitle');
    filters.append(allFilter, projectFilter);
    const nav = make('nav', 'codex-wb-nav');
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-orientation', 'vertical');
    const brand = make('div', 'codex-wb-brand');
    brand.textContent = 'Codex Overleaf Link';
    sidebar.append(filters, nav, brand);
    const main = make('div', 'codex-wb-main');
    const body = make('div', 'codex-wb-body');
    const footer = make('footer', 'codex-wb-footer');
    if (status) { status.setAttribute('aria-live', 'polite'); footer.append(status); }
    main.append(body, footer);
    layout.append(sidebar, main);
    dialog.append(header, layout);
    const pages = new Map(), navButtons = new Map(), groups = [];
    let active = 'general', filter = 'all', returnFocus = null, destroyed = false;
    let providerRequested = false, providerCloseGuard = null, closing = null;

    for (const [id, key, icon] of CATEGORIES) {
      const page = make('section', 'codex-wb-page');
      page.id = 'codex-settings-page-' + id;
      page.dataset.workbenchPage = id;
      page.setAttribute('role', 'tabpanel');
      page.setAttribute('aria-labelledby', 'codex-settings-nav-' + id);
      page.hidden = true;
      page.append(make('h3', 'codex-wb-page-title', key));
      pages.set(id, page);
      const tab = button('codex-wb-nav-button');
      tab.id = 'codex-settings-nav-' + id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', page.id);
      if (options.icon) {
        const glyph = make('span', 'codex-wb-nav-icon');
        glyph.innerHTML = options.icon(icon); // Static, repository-owned icon paths only.
        tab.append(glyph);
      }
      tab.append(make('span', '', key));
      listen(tab, 'click', () => select(id));
      nav.append(tab);
      navButtons.set(id, tab);
    }
    function addGroup(node, category, projectOnly) {
      node.hidden = true;
      node.dataset.workbenchScope = projectOnly ? 'project' : 'global';
      const summary = node.querySelector('summary');
      const badge = make('span', 'codex-wb-scope-label',
        projectOnly ? 'settingsScopeProjectTitle' : 'settingsScopeGlobalTitle');
      (summary || node).append(badge);
      pages.get(category).append(node);
      groups.push({ node, category, projectOnly, expanded: true });
    }
    // Move existing controls rather than copying them. Their listeners, unsaved
    // values, identity, validation and persistence callbacks remain attached.
    for (const group of Array.from(settings.querySelectorAll('[data-set-group]'))) {
      const key = group.dataset.setGroup;
      const originalScope = group.closest('.codex-project-settings-scope');
      const projectOnly = PROJECT_GROUPS.has(key)
        || (!GROUP_PAGES[key] && originalScope && !originalScope.classList.contains('codex-project-settings-scope--global'));
      addGroup(group, GROUP_PAGES[key] || 'instructions', Boolean(projectOnly));
    }
    // Preserve non-card controls, including the legacy skill-loading entry.
    // Scope headings are replaced by labels on the actual groups.
    for (const scope of Array.from(settings.querySelectorAll('.codex-project-settings-scope'))) {
      scope.querySelectorAll('.codex-project-settings-scope-title').forEach(node => node.remove());
      if (scope.children.length) {
        addGroup(scope, 'instructions', !scope.classList.contains('codex-project-settings-scope--global'));
      } else scope.remove();
    }
    for (const node of Array.from(settings.children)) {
      if (node === status) continue;
      addGroup(node, 'instructions', false);
    }
    const providerHost = make('div', 'codex-wb-provider-host');
    providerHost.dataset.providerSettingsHost = '';
    pages.get('providers').append(providerHost);
    settings.append(...pages.values());
    body.append(settings);
    if (skills) {
      const back = skills.querySelector('[data-skills-back]');
      if (back) back.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9.5 4-4 4 4 4"/></svg>';
      const masterRow = skills.querySelector('[data-load-codex-overleaf-skills]')?.closest('label');
      const masterTitle = masterRow?.querySelector('.codex-project-settings-row-label');
      if (masterRow && masterTitle) {
        if (masterRow.parentElement !== skills) {
          masterRow.parentElement.classList.remove('codex-set-card');
          masterRow.parentElement.classList.add('codex-wb-skills-master');
        }
        masterRow.classList.add('codex-wb-skills-master-row');
        masterTitle.dataset.i18n = 'settingsWorkbenchEnableSkills';
        masterTitle.classList.add('codex-wb-skills-caption');
        const copy = make('div', 'codex-wb-skills-master-copy');
        masterTitle.before(copy);
        copy.append(masterTitle, make('p', 'codex-wb-skills-help codex-wb-skills-caption', 'settingsWorkbenchSkillsHelp'));
      }
      skills.querySelector('[data-local-skill-list]')?.before(
        make('div', 'codex-wb-skills-list-title codex-wb-skills-caption', 'settingsWorkbenchSkillsList')
      );
      body.append(skills);
    }
    container.append(dialog);
    panel.dataset.settingsWorkbench = 'true';

    const themeSelect = settings.querySelector('[data-theme-select]');
    let themeChoices = null;
    if (themeSelect) {
      const row = themeSelect.closest('label') || themeSelect;
      themeSelect.hidden = true;
      themeChoices = make('div', 'codex-wb-themes');
      themeChoices.setAttribute('role', 'radiogroup');
      for (const [value, key] of [['light', 'themeLight'], ['dark', 'themeDark'], ['auto', 'themeAuto']]) {
        const choice = button('codex-wb-theme-choice');
        choice.dataset.themeChoice = value;
        choice.setAttribute('role', 'radio');
        const preview = make('span', 'codex-wb-theme-preview');
        preview.dataset.previewTheme = value;
        preview.setAttribute('aria-hidden', 'true');
        const lines = make('span', 'codex-wb-theme-lines');
        lines.append(make('b'), make('b'), make('b'));
        preview.append(lines);
        choice.append(preview, make('span', 'codex-wb-theme-caption', key));
        listen(choice, 'click', () => {
          themeSelect.value = value;
          themeSelect.dispatchEvent(new win.Event('input', { bubbles: true }));
          themeSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
          updateThemes();
        });
        themeChoices.append(choice);
      }
      row.after(themeChoices);
      listen(themeChoices, 'keydown', event => {
        const choices = Array.from(themeChoices.querySelectorAll('button'));
        const index = choices.indexOf(event.target);
        if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
          : (index + (event.key === 'ArrowLeft' ? -1 : 1) + choices.length) % choices.length;
        choices[next].click(); choices[next].focus();
      });
    }
    function updateThemes() {
      themeChoices?.setAttribute('aria-label', t('themeLabel'));
      for (const choice of themeChoices?.querySelectorAll('button') || []) {
        const selected = choice.dataset.themeChoice === themeSelect.value;
        choice.setAttribute('aria-checked', String(selected));
        choice.tabIndex = selected ? 0 : -1;
      }
    }
    function hasProject() {
      return panel.dataset.settingsScope !== 'account'
        && /^\/project\/[^/]+/.test(win?.location?.pathname || '');
    }
    function available(item) {
      return (!item.projectOnly || hasProject()) && (filter !== 'project' || item.projectOnly);
    }
    function refresh() {
      if (destroyed) return;
      if (!hasProject()) filter = 'all';
      if (panel.dataset.view === 'skills') { active = 'instructions'; filter = 'all'; }
      const availablePages = new Set(groups.filter(available).map(item => item.category));
      if (!availablePages.has(active)) active = CATEGORIES.find(([id]) => availablePages.has(id))?.[0] || 'general';
      for (const node of dialog.querySelectorAll('[data-i18n]')) {
        // Existing controls use their established translation pass; update the
        // newly owned chrome only, without replacing controls or skill rows.
        if (node.closest('.codex-wb-header, .codex-wb-nav, .codex-wb-filters, .codex-wb-footer')
          || node.classList.contains('codex-wb-page-title')
          || node.classList.contains('codex-wb-scope-label')
          || node.classList.contains('codex-wb-theme-caption')
          || node.classList.contains('codex-wb-skills-caption')) node.textContent = t(node.dataset.i18n);
      }
      projectFilter.disabled = !hasProject();
      projectFilter.title = hasProject() ? t('settingsWorkbenchProjectFilter') : t('settingsWorkbenchOpenProject');
      filters.setAttribute('aria-label', t('settingsWorkbenchFilter'));
      nav.setAttribute('aria-label', t('settingsWorkbenchCategories'));
      allFilter.setAttribute('aria-pressed', String(filter === 'all'));
      projectFilter.setAttribute('aria-pressed', String(filter === 'project'));
      closeButton.title = t('settingsWorkbenchClose');
      closeButton.setAttribute('aria-label', t('settingsWorkbenchClose'));
      for (const [id, tab] of navButtons) {
        tab.hidden = !availablePages.has(id);
        tab.setAttribute('aria-selected', String(id === active));
        tab.tabIndex = id === active ? 0 : -1;
        pages.get(id).hidden = id !== active;
      }
      for (const item of groups) {
        const visible = available(item) && item.category === active && panel.dataset.view !== 'skills';
        if (item.node.tagName === 'DETAILS' && item.node.hidden !== !visible) {
          if (!visible) item.expanded = item.node.open;
          item.node.open = visible && item.expanded;
        }
        item.node.hidden = !visible;
      }
      updateThemes();
    }
    function requestProviders() {
      if (active !== 'providers' || providerRequested || typeof instance.callbacks.onProvidersOpen !== 'function') return;
      providerRequested = true;
      const failed = error => {
        providerRequested = false;
        if (status && !destroyed) {
          status.textContent = error?.message || t('settingsWorkbenchProviderOpenFailed');
          status.dataset.status = 'failed';
        }
      };
      try { Promise.resolve(instance.callbacks.onProvidersOpen()).catch(failed); }
      catch (error) { failed(error); }
    }
    function revealProviders() {
      active = 'providers';
      filter = 'all';
      providerRequested = true;
      pages.get('providers').dataset.providerEmbedded = 'true';
      panel.dataset.view = 'settings';
      refresh();
      return providerHost;
    }
    function requestClose() {
      if (closing) return closing;
      closing = (async () => {
        if (providerCloseGuard && !await providerCloseGuard()) return;
        if (!destroyed) instance.callbacks.onBack?.();
      })().catch(error => {
        if (status && !destroyed) {
          status.textContent = error?.message || t('settingsWorkbenchProviderOpenFailed');
          status.dataset.status = 'failed';
        }
      }).finally(() => { closing = null; });
      return closing;
    }
    function select(id) {
      active = id;
      if (panel.dataset.view === 'skills') instance.callbacks.onSkillsBack?.();
      refresh();
      body.scrollTop = 0;
      if (dialog.open) requestProviders();
    }
    function show() {
      if (destroyed) return;
      refresh();
      if (!dialog.open) {
        returnFocus = doc.activeElement;
        dialog.showModal();
        panel.dataset.settingsWorkbenchOpen = 'true';
        navButtons.get(active)?.focus();
      }
      requestProviders();
    }
    function hide() {
      providerRequested = false;
      if (!dialog.open) return;
      if (dialog.contains(doc.activeElement)) doc.activeElement?.blur?.();
      dialog.close();
      delete panel.dataset.settingsWorkbenchOpen;
      if (returnFocus?.isConnected) returnFocus.focus?.();
    }
    const syncView = () => {
      refresh();
      if (['settings', 'skills'].includes(panel.dataset.view)) show();
      else hide();
    };
    listen(allFilter, 'click', () => { filter = 'all'; refresh(); });
    listen(projectFilter, 'click', () => {
      filter = 'project';
      if (panel.dataset.view === 'skills') instance.callbacks.onSkillsBack?.();
      refresh();
      body.scrollTop = 0;
    });
    listen(nav, 'keydown', event => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const tabs = Array.from(navButtons.values()).filter(tab => !tab.hidden);
      const index = tabs.indexOf(event.target);
      if (index < 0) return;
      event.preventDefault(); event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + tabs.length) % tabs.length;
      tabs[next].click(); tabs[next].focus();
    });
    listen(closeButton, 'click', event => {
      if (!providerCloseGuard) return;
      event.preventDefault(); event.stopImmediatePropagation();
      void requestClose();
    }, true);
    listen(dialog, 'cancel', event => {
      // File-input cancel events bubble; only this dialog's own cancel closes it.
      if (event.target !== dialog) return;
      event.preventDefault(); event.stopPropagation();
      void requestClose();
    });
    listen(dialog, 'change', refresh);
    const observer = new win.MutationObserver(syncView);
    observer.observe(panel, { attributes: true, attributeFilter: ['data-view', 'data-settings-scope', 'data-theme'] });
    refresh();
    return {
      show, hide, refresh, revealProviders,
      setProviderCloseGuard(guard) { providerCloseGuard = guard; },
      destroy() {
        destroyed = true;
        observer.disconnect();
        listeners.splice(0).forEach(dispose => dispose());
        hide();
        dialog.remove();
        delete panel.dataset.settingsWorkbench;
      }
    };
  }
  return { mount };
});
