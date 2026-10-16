(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('SettingsWorkbench', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The sidebar is split by scope; a page's section decides whether its groups
  // need an open project. Pages: [id, label key, icon].
  const SECTIONS = [
    ['project', 'settingsScopeProjectTitle', [
      ['writing', 'settingsWorkbenchWriting', 'pen'],
      ['protection', 'settingsWorkbenchProtection', 'shield'],
      ['cache', 'otSettingsTitle', 'flask'],
      ['history', 'settingsWorkbenchChanges', 'history']
    ]],
    ['global', 'settingsScopeGlobalTitle', [
      ['appearance', 'appearanceTitle', 'appearance'],
      ['providers', 'settingsWorkbenchModels', 'bolt'],
      ['context', 'settingsWorkbenchContextSkills', 'database'],
      ['storage', 'storageTitle', 'archive'],
      ['updates', 'softwareUpdatesTitle', 'software']
    ]]
  ];
  const GROUP_PAGES = {
    'writing-style': 'writing', personalization: 'writing', protection: 'protection', privacy: 'protection',
    experimental: 'cache', history: 'history', appearance: 'appearance', providers: 'providers',
    'context-loading': 'context', skills: 'context', storage: 'storage', updates: 'updates'
  };
  // Groups without a mapping keep their original scope.
  const FALLBACK_PAGES = { project: 'writing', global: 'context' };
  // The skills list opens in place of the page that holds the Skills group.
  const SKILLS_PAGE = 'context';

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
    const title = make('h2', 'codex-wb-title', 'settingsWorkbenchTitle');
    title.id = 'codex-settings-workbench-title';
    closeButton.classList.add('codex-wb-close');
    if (options.icon) closeButton.innerHTML = options.icon('close'); // Static, repository-owned icon path.
    else closeButton.textContent = '\u00d7';
    originalHead?.remove();

    const layout = make('div', 'codex-wb-layout');
    const sidebar = make('aside', 'codex-wb-sidebar');
    const nav = make('nav', 'codex-wb-nav');
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-orientation', 'vertical');
    sidebar.append(title, nav);
    const main = make('div', 'codex-wb-main');
    const body = make('div', 'codex-wb-body');
    const footer = make('footer', 'codex-wb-footer');
    if (status) { status.setAttribute('aria-live', 'polite'); footer.append(status); }
    main.append(body, footer);
    layout.append(sidebar, main);
    // The close button floats over the content's top-right corner.
    dialog.append(layout, closeButton);
    const pages = new Map(), navButtons = new Map(), pageScopes = new Map(), sectionLabels = new Map(), groups = [];
    let active = 'writing', returnFocus = null, destroyed = false;
    let providerRequested = false, providerCloseGuard = null, closing = null;

    for (const [scope, sectionKey, items] of SECTIONS) {
      // Visual section heading; each tab references it as its description.
      const label = make('div', 'codex-wb-nav-section', sectionKey);
      label.id = 'codex-settings-nav-section-' + scope;
      label.setAttribute('aria-hidden', 'true');
      nav.append(label);
      sectionLabels.set(scope, label);
      for (const [id, key, icon] of items) {
        const page = make('section', 'codex-wb-page');
        page.id = 'codex-settings-page-' + id;
        page.dataset.workbenchPage = id;
        page.setAttribute('role', 'tabpanel');
        page.setAttribute('aria-labelledby', 'codex-settings-nav-' + id);
        page.hidden = true;
        page.append(make('h3', 'codex-wb-page-title', key), make('p', 'codex-wb-page-scope'));
        pages.set(id, page);
        pageScopes.set(id, scope);
        const tab = button('codex-wb-nav-button');
        tab.id = 'codex-settings-nav-' + id;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', page.id);
        tab.setAttribute('aria-describedby', label.id);
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
    }
    function addGroup(node, category) {
      const projectOnly = pageScopes.get(category) === 'project';
      node.hidden = true;
      node.dataset.workbenchScope = projectOnly ? 'project' : 'global';
      const summary = node.querySelector('summary');
      if (summary) {
        // Groups are plain sections: always open while their page is shown.
        summary.tabIndex = -1;
        listen(summary, 'click', event => event.preventDefault());
      }
      pages.get(category).append(node);
      groups.push({ node, category, projectOnly });
    }
    const fallbackPage = scope => FALLBACK_PAGES[
      scope && !scope.classList.contains('codex-project-settings-scope--global') ? 'project' : 'global'];
    // Move existing controls rather than copying them. Their listeners, unsaved
    // values, identity, validation and persistence callbacks remain attached.
    for (const group of Array.from(settings.querySelectorAll('[data-set-group]'))) {
      const key = group.dataset.setGroup;
      addGroup(group, GROUP_PAGES[key] || fallbackPage(group.closest('.codex-project-settings-scope')));
    }
    // Preserve non-card controls. The sidebar sections replace the scope headings.
    for (const scope of Array.from(settings.querySelectorAll('.codex-project-settings-scope'))) {
      scope.querySelectorAll('.codex-project-settings-scope-title').forEach(node => node.remove());
      if (scope.children.length) addGroup(scope, fallbackPage(scope));
      else scope.remove();
    }
    for (const node of Array.from(settings.children)) {
      if (node === status) continue;
      addGroup(node, FALLBACK_PAGES.global);
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
      return !item.projectOnly || hasProject();
    }
    // A page whose only visible group repeats the page title hides that group's
    // title; the group header keeps only its Saved mark.
    function refreshSoleSections() {
      for (const page of pages.values()) {
        const pageGroups = Array.from(page.querySelectorAll('.codex-set-group'));
        const visibleGroups = pageGroups.filter(node => !node.hidden);
        const pageTitle = page.querySelector('.codex-wb-page-title')?.textContent.trim();
        for (const node of pageGroups) {
          const groupTitle = node.querySelector('.codex-set-group-head .codex-set-group-title');
          const sole = visibleGroups.length === 1 && visibleGroups[0] === node
            && groupTitle && groupTitle.textContent.trim() === pageTitle;
          if (sole) node.dataset.soleSection = 'true';
          else delete node.dataset.soleSection;
        }
      }
    }
    // Each page states its scope once, under its title.
    function renderPageScope(page, scope, projectName) {
      const line = page.querySelector('.codex-wb-page-scope');
      if (!line) return;
      const text = t(scope === 'project' ? 'settingsPageScopeProject' : 'settingsPageScopeGlobal');
      if (scope !== 'project' || !projectName) { line.textContent = text; return; }
      const name = doc.createElement('b');
      name.textContent = projectName;
      line.replaceChildren(text + ' \u00b7 ', name);
    }
    function refresh() {
      if (destroyed) return;
      if (panel.dataset.view === 'skills') active = SKILLS_PAGE;
      const availablePages = new Set(groups.filter(available).map(item => item.category));
      if (!availablePages.has(active)) active = Array.from(navButtons.keys()).find(id => availablePages.has(id)) || 'appearance';
      for (const node of dialog.querySelectorAll('[data-i18n]')) {
        // Existing controls use their established translation pass; update the
        // newly owned chrome only, without replacing controls or skill rows.
        if (node.closest('.codex-wb-nav, .codex-wb-footer')
          || node.classList.contains('codex-wb-title')
          || node.classList.contains('codex-wb-page-title')
          || node.classList.contains('codex-wb-theme-caption')
          || node.classList.contains('codex-wb-skills-caption')) node.textContent = t(node.dataset.i18n);
      }
      const projectName = hasProject() ? String(instance.getProjectName?.() || '').trim() : '';
      for (const [id, page] of pages) renderPageScope(page, pageScopes.get(id), projectName);
      for (const [scope, label] of sectionLabels) {
        label.hidden = !Array.from(pageScopes).some(([id, pageScope]) => pageScope === scope && availablePages.has(id));
      }
      nav.setAttribute('aria-label', t('settingsWorkbenchCategories'));
      closeButton.title = t('settingsWorkbenchClose');
      closeButton.setAttribute('aria-label', t('settingsWorkbenchClose'));
      const skillsBack = skills?.querySelector('[data-skills-back]');
      if (skillsBack) {
        skillsBack.title = t('settingsBack');
        skillsBack.setAttribute('aria-label', t('settingsBack'));
      }
      if (status) status.hidden = Boolean(status.dataset.statusPage) && status.dataset.statusPage !== active;
      for (const [id, tab] of navButtons) {
        tab.hidden = !availablePages.has(id);
        tab.setAttribute('aria-selected', String(id === active));
        tab.tabIndex = id === active ? 0 : -1;
        pages.get(id).hidden = id !== active;
      }
      for (const item of groups) {
        const visible = available(item) && item.category === active && panel.dataset.view !== 'skills';
        // Opening a group when its page is shown keeps the lazy toggle loaders (history, storage).
        if (item.node.tagName === 'DETAILS' && item.node.open !== visible) item.node.open = visible;
        item.node.hidden = !visible;
      }
      refreshSoleSections();
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
    // Shows the page that holds a group and returns the group, or null when the
    // group is unavailable (for example a project group outside a project).
    function revealGroup(key) {
      const item = groups.find(entry => entry.node.dataset?.setGroup === key);
      if (!item || !available(item)) return null;
      active = item.category;
      refresh();
      return item.node;
    }
    function revealProviders() {
      active = 'providers';
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
      show, hide, refresh, revealGroup, revealProviders,
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
