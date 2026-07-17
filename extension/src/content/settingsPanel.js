(function initCodexOverleafSettingsPanel() {
  'use strict';

  function codexIcon(name) {
    const icons = {
      appearance: '<path d="M8 2.2v1.1"/><path d="M8 12.7v1.1"/><path d="M2.2 8h1.1"/><path d="M12.7 8h1.1"/><path d="m3.9 3.9.8.8"/><path d="m11.3 11.3.8.8"/><path d="m12.1 3.9-.8.8"/><path d="m4.7 11.3-.8.8"/><circle cx="8" cy="8" r="2.4"/>',
      bolt: '<path d="M8.9 1.8 3.8 8.8h3.3l-.5 5.4 5.5-7.5H8.8z"/>',
      database: '<ellipse cx="8" cy="4" rx="4.5" ry="1.9"/><path d="M3.5 4v4c0 1 2 1.9 4.5 1.9s4.5-.9 4.5-1.9V4"/><path d="M3.5 8v4c0 1 2 1.9 4.5 1.9s4.5-.9 4.5-1.9V8"/>',
      flask: '<path d="M6 2.5h4"/><path d="M7 2.5v4.1l-3.4 5.3A1.4 1.4 0 0 0 4.8 14h6.4a1.4 1.4 0 0 0 1.2-2.1L9 6.6V2.5"/><path d="M5.3 10.5h5.4"/>',
      history: '<path d="M4.2 3.4h7.6"/><path d="M4.2 8h7.6"/><path d="M4.2 12.6h4.6"/><path d="M2.2 3.4h.1"/><path d="M2.2 8h.1"/><path d="M2.2 12.6h.1"/>',
      lock: '<rect x="3.6" y="7" width="8.8" height="6.2" rx="1.2"/><path d="M5.6 7V5.3a2.4 2.4 0 0 1 4.8 0V7"/><path d="M8 9.6v1.2"/>',
      pen: '<path d="M3.2 12.8 4 9.7l6.6-6.6a1.4 1.4 0 0 1 2 2L6 11.7z"/><path d="m9.6 4.1 2.3 2.3"/>',
      shield: '<path d="M8 2.1 12.4 4v3.5c0 2.9-1.8 5.1-4.4 6.4-2.6-1.3-4.4-3.5-4.4-6.4V4z"/><path d="M6.1 8.1 7.5 9.5 10.2 6.6"/>',
      software: '<rect x="5.1" y="5.1" width="5.8" height="5.8" rx="1.2"/><path d="M12.9 7.1A5.2 5.2 0 0 0 4.1 4.2"/><path d="M4.1 2.2v2h2"/><path d="M3.1 8.9a5.2 5.2 0 0 0 8.8 2.9"/><path d="M11.9 13.8v-2h-2"/>'
    };
    const safeName = Object.prototype.hasOwnProperty.call(icons, name) ? name : 'appearance';
    return `<span class="codex-icon codex-icon-${safeName}" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false">${icons[safeName]}</svg></span>`;
  }

  function codexSetIcon(name) {
    return `<span class="codex-set-group-icon">${codexIcon(name)}</span>`;
  }

  function create(options = {}) {
    const container = options.container;
    if (!container) {
      throw new Error('CodexOverleafSettingsPanel requires a container');
    }
    const instance = {
      container,
      callbacks: options.callbacks || {},
      i18n: options.i18n || null,
      button: options.button || null
    };

    container.innerHTML = `
      <section class="codex-custom-instructions-panel codex-project-settings-panel" data-custom-instructions-panel data-project-settings-panel>
        <div class="codex-custom-instructions-head">
          <button type="button" data-settings-back title="Back" aria-label="Back">‹</button>
          <div>
            <div class="codex-custom-instructions-title" data-i18n="projectSettingsTitle">Project Settings</div>
            <div class="codex-custom-instructions-subtitle" data-i18n="projectSettingsSubtitle">Customize how Codex behaves in this and all projects.</div>
          </div>
        </div>
        <div class="codex-project-settings-status" data-project-settings-status></div>
        <div class="codex-project-settings-scope">
          <div class="codex-project-settings-scope-title codex-set-eyebrow" data-i18n="settingsScopeProjectTitle">This project</div>
          <details class="codex-set-group" data-set-group="personalization" open>
            <summary class="codex-set-group-head">
              <span class="codex-set-group-title">${codexSetIcon('pen')}<span data-i18n="personalizationConfig">Personalization</span></span>
              <span class="codex-set-saved" data-set-saved hidden>✓ <span data-i18n="settingsSaved">Saved</span></span>
            </summary>
            <div class="codex-set-card">
              <p class="codex-set-row-help" data-i18n="personalizationHelp">Style, terminology, and LaTeX conventions Codex should follow in this project.</p>
              <textarea id="codex-custom-instructions-input" class="codex-custom-instructions-input" data-custom-instructions-input rows="6" placeholder="Style, terminology, venue constraints, and LaTeX conventions for this project."></textarea>
            </div>
          </details>
          <details class="codex-set-group" data-set-group="protection" open>
            <summary class="codex-set-group-head">
              <span class="codex-set-group-title">${codexSetIcon('shield')}<span data-i18n="fileProtectionTitle">File protection</span></span>
              <span class="codex-set-saved" data-set-saved hidden>✓ <span data-i18n="settingsSaved">Saved</span></span>
            </summary>
            <div class="codex-set-card">
              <div class="codex-set-row">
                <label class="codex-set-row-label" for="codex-governance-readonly-patterns" data-i18n="governanceReadonlyPatterns">Read-only patterns</label>
                <p class="codex-set-row-help" data-i18n="governanceReadonlyHelp">Files Codex must never modify (one glob per line).</p>
                <textarea id="codex-governance-readonly-patterns" class="codex-project-settings-textarea" data-governance-readonly-patterns rows="3" placeholder="paper/accepted/**&#10;main.tex"></textarea>
                <div class="codex-set-note" data-governance-readonly-note hidden></div>
              </div>
              <div class="codex-set-row">
                <label class="codex-set-row-label" for="codex-governance-writable-patterns" data-i18n="governanceWritablePatterns">Writable patterns</label>
                <p class="codex-set-row-help" data-i18n="governanceWritableHelp">Files Codex may edit (one glob per line).</p>
                <textarea id="codex-governance-writable-patterns" class="codex-project-settings-textarea" data-governance-writable-patterns rows="3" placeholder="sections/**&#10;figures/**"></textarea>
                <div class="codex-set-note" data-governance-writable-note hidden></div>
              </div>
            </div>
          </details>
          <details class="codex-set-group" data-set-group="privacy" open>
            <summary class="codex-set-group-head">
              <span class="codex-set-group-title">${codexSetIcon('lock')}<span data-i18n="privacyTitle">Privacy</span></span>
              <span class="codex-set-saved" data-set-saved hidden>✓ <span data-i18n="settingsSaved">Saved</span></span>
            </summary>
            <div class="codex-set-card">
              <label class="codex-project-settings-row codex-project-settings-row--switch">
                <span class="codex-project-settings-row-label" data-i18n="sensitiveCheckEnabled">Check for sensitive content before Codex runs</span>
                <input type="checkbox" class="codex-switch" data-sensitive-check-enabled>
              </label>
              <p class="codex-set-row-help" data-i18n="sensitiveCheckHelp">Scan project files for secrets and PII before each Codex run.</p>
              <label class="codex-project-settings-row codex-project-settings-row--switch">
                <span class="codex-project-settings-row-label" data-i18n="sensitiveConfirmAllowed">Allow explicit confirmation when sensitive findings exist</span>
                <input type="checkbox" class="codex-switch" data-sensitive-confirm-allowed>
              </label>
              <p class="codex-set-row-help" data-i18n="sensitiveConfirmHelp">Let you review and proceed when the scan flags content.</p>
            </div>
          </details>
          <details class="codex-set-group" data-set-group="experimental">
            <summary class="codex-set-group-head">
              <span class="codex-set-group-title">${codexSetIcon('flask')}<span data-i18n="experimentalTitle">Experimental</span></span>
              <span class="codex-set-saved" data-set-saved hidden>✓ <span data-i18n="settingsSaved">Saved</span></span>
            </summary>
            <div class="codex-set-card">
              <label class="codex-project-settings-row codex-project-settings-row--switch">
                <span class="codex-project-settings-row-label">
                  <span data-i18n="experimentalOtMenuTitle">Experimental OT Mirror</span>
                  <small class="codex-set-row-sub" data-i18n="experimentalOtMenuSubtitle">Experimental — speeds up reading the file you are editing; Codex falls back to normal reading whenever unsure.</small>
                </span>
                <input type="checkbox" class="codex-switch" data-experimental-ot>
              </label>
              <p class="codex-set-row-help" data-experimental-ot-menu-status></p>
            </div>
          </details>
        </div>
        <div class="codex-project-settings-scope codex-project-settings-scope--global">
          <details class="codex-set-group" data-set-group="history" data-history-card>
            <summary class="codex-set-group-head">
              <span class="codex-set-group-title">${codexSetIcon('history')}<span data-i18n="historyTitle">Change history</span></span>
            </summary>
            <div class="codex-set-card">
              <p class="codex-set-row-help" data-i18n="historyHelp">What Codex wrote to this project, per run. Filter by file name or task text.</p>
              <input type="text" class="codex-set-select codex-history-filter" data-history-filter>
              <div class="codex-history-list" data-history-list></div>
            </div>
          </details>
          <div class="codex-project-settings-scope-title codex-set-eyebrow" data-i18n="settingsScopeGlobalTitle">All projects</div>
          <details class="codex-set-group" data-set-group="appearance" open>
            <summary class="codex-set-group-head">
              <span class="codex-set-group-title">${codexSetIcon('appearance')}<span data-i18n="appearanceTitle">Appearance</span></span>
              <span class="codex-set-saved" data-set-saved hidden>✓ <span data-i18n="settingsSaved">Saved</span></span>
            </summary>
            <div class="codex-set-card">
              <label class="codex-project-settings-row codex-project-settings-row--select">
                <span class="codex-project-settings-row-label" data-i18n="themeLabel">Theme</span>
                <select class="codex-set-select" data-theme-select>
                  <option value="dark" data-i18n="themeDark">Dark</option>
                  <option value="light" data-i18n="themeLight">Light</option>
                  <option value="auto" data-i18n="themeAuto">Follow system</option>
                </select>
              </label>
              <p class="codex-set-row-help" data-i18n="themeHelp">Switch the Codex panel between dark, light, or following your operating system.</p>
              <label class="codex-project-settings-row codex-project-settings-row--select">
                <span class="codex-project-settings-row-label" data-i18n="languageLabel">Language</span>
                <select class="codex-set-select" data-language-select>
                  <option value="en" data-i18n="languageEnglish">English</option>
                  <option value="zh" data-i18n="languageChinese">中文</option>
                </select>
              </label>
              <p class="codex-set-row-help" data-i18n="languageHelp">Panel display language.</p>
            </div>
          </details>
          <details class="codex-set-group" data-set-group="providers" open>
            <summary class="codex-set-group-head">
              <span class="codex-set-group-title">${codexSetIcon('bolt')}<span data-i18n="providerSettingsTitle">Model providers</span><span class="codex-provider-experimental-badge" data-i18n="providerSettingsExperimental">Third-party experimental</span></span>
            </summary>
            <div class="codex-set-card codex-provider-settings-entry">
              <div class="codex-provider-settings-entry-copy">
                <p class="codex-set-row-help" data-i18n="providerSettingsHelp">Configure experimental third-party model APIs. Compatibility varies by provider and gateway.</p>
                <p class="codex-provider-settings-summary" data-provider-settings-summary data-tone="ok" data-i18n="providerSettingsBuiltin">Built-in Codex is active</p>
              </div>
              <button type="button" class="codex-set-btn" data-provider-settings-open data-i18n="providerSettingsConfigure">Configure</button>
            </div>
          </details>
          <details class="codex-set-group" data-set-group="updates" open>
            <summary class="codex-set-group-head">
              <span class="codex-set-group-title">${codexSetIcon('software')}<span data-i18n="softwareUpdatesTitle">Software updates</span></span>
            </summary>
            <div class="codex-set-card" data-update-settings>
              <div class="codex-set-row">
                <label class="codex-project-settings-row codex-project-settings-row--switch">
                  <span class="codex-project-settings-row-label" data-i18n="preloadProjectContextTitle">Preload project context</span>
                  <input type="checkbox" class="codex-switch" data-preload-project-context>
                </label>
                <p class="codex-set-row-help" data-i18n="preloadProjectContextDescription">Fetch the exact project file list in the background after an Overleaf project becomes idle.</p>
                <p class="codex-set-row-help" data-update-settings-summary data-i18n="softwareUpdatesHelp">Automatically checks signed stable releases for the Extension and Native Host.</p>
                <p class="codex-set-note" data-update-settings-state aria-live="polite" hidden></p>
                <button type="button" class="codex-set-btn" data-check-updates data-i18n="checkForUpdates">Check for updates</button>
              </div>
            </div>
          </details>
          <details class="codex-set-group" data-set-group="storage" data-storage-card>
            <summary class="codex-set-group-head">
              <span class="codex-set-group-title">${codexSetIcon('database')}<span data-i18n="storageTitle">History &amp; storage</span></span>
            </summary>
            <div class="codex-set-card">
              <p class="codex-set-row-help" data-storage-usage data-i18n="storageUsageLoading">Calculating usage…</p>
              <button type="button" class="codex-set-btn codex-set-btn--danger" data-clear-all-history data-i18n="storageClearAll">Clear all history…</button>
              <p class="codex-set-row-help" data-i18n="storageClearAllHelp">Removes every stored session, run and audit record for all projects. Project settings and rules are kept.</p>
            </div>
          </details>
          <details class="codex-set-group" data-set-group="skills" open>
            <summary class="codex-set-group-head">
              <span class="codex-set-group-title">${codexSetIcon('bolt')}<span data-i18n="localSkillsTitle">Skills</span></span>
              <span class="codex-set-saved" data-set-saved hidden>✓ <span data-i18n="settingsSaved">Saved</span></span>
            </summary>
            <div class="codex-set-card">
              <label class="codex-project-settings-row codex-project-settings-row--switch">
                <span class="codex-project-settings-row-label" data-i18n="loadCodexLocalSkills">Load local Codex skills</span>
                <input type="checkbox" class="codex-switch" data-load-codex-local-skills>
              </label>
              <p class="codex-set-row-help" data-i18n="loadCodexLocalSkillsHelp">Pull skills from your local Codex installation.</p>
              <button type="button" class="codex-skills-entry" data-skills-entry>
                <span class="codex-skills-entry-label" data-i18n="codexOverleafSkillsEntry">Codex Overleaf skills</span>
                <span class="codex-skills-entry-summary" data-skills-entry-summary></span>
                <span class="codex-skills-entry-chevron" aria-hidden="true">›</span>
              </button>
            </div>
          </details>
        </div>
      </section>
      <section class="codex-custom-instructions-panel codex-skills-panel" data-skills-screen>
        <div class="codex-custom-instructions-head">
          <button type="button" data-skills-back title="Back" aria-label="Back">‹</button>
          <div>
            <div class="codex-custom-instructions-title" data-i18n="codexOverleafSkillsTitle">Codex Overleaf skills</div>
          </div>
          <span class="codex-set-saved" data-set-saved hidden>✓ <span data-i18n="settingsSaved">Saved</span></span>
        </div>
        <div class="codex-set-card">
          <label class="codex-project-settings-row codex-project-settings-row--switch">
            <span class="codex-project-settings-row-label" data-i18n="loadCodexOverleafSkills">Load Codex Overleaf skills</span>
            <input type="checkbox" class="codex-switch" data-load-codex-overleaf-skills>
          </label>
        </div>
        <div class="codex-skills-divider"></div>
        <div class="codex-local-skill-list" data-local-skill-list></div>
      </section>
    `;

    container.querySelector('[data-settings-back]')?.addEventListener('click', () => instance.callbacks.onBack?.());
    container.querySelector('[data-skills-back]')?.addEventListener('click', () => instance.callbacks.onSkillsBack?.());
    container.querySelector('[data-skills-entry]')?.addEventListener('click', () => instance.callbacks.onSkillsOpen?.());
    container.querySelector('[data-provider-settings-open]')?.addEventListener('click', () => instance.callbacks.onProvidersOpen?.());
    container.querySelector('[data-clear-all-history]')?.addEventListener('click', () => instance.callbacks.onClearAllHistory?.());
    container.querySelector('[data-history-card]')?.addEventListener('toggle', event => {
      if (event.target.open) {
        instance.callbacks.onHistoryOpen?.();
      }
    });
    container.querySelector('[data-history-filter]')?.addEventListener('input', () => instance.callbacks.onHistoryFilter?.());
    // Experimental OT mirror: a single visible switch. The click is
    // intercepted (the runtime's handler preventDefaults, runs the enable
    // confirmation, then sets checked + drives the change flow itself) so the
    // confirm-before-enable contract survives the control unification.
    container.querySelector('[data-experimental-ot]')?.addEventListener('click', event => instance.callbacks.onOtToggleClick?.(event));
    // Personalization textarea: auto-save on change (the change event fires on blur — avoids per-keystroke saves).
    const customInstructionsInput = container.querySelector('[data-custom-instructions-input]');
    customInstructionsInput?.addEventListener('change', event => {
      instance.callbacks.onInputChange?.(event);
      flashSaved(instance, event);
    });
    // Governance and skill fields: auto-save on change and input for immediate response.
    for (const selector of ['[data-governance-readonly-patterns]', '[data-governance-writable-patterns]', '[data-sensitive-check-enabled]', '[data-sensitive-confirm-allowed]', '[data-preload-project-context]', '[data-load-codex-local-skills]', '[data-load-codex-overleaf-skills]', '[data-theme-select]', '[data-language-select]']) {
      const element = container.querySelector(selector);
      element?.addEventListener?.('change', event => {
        instance.callbacks.onInputChange?.(event);
        flashSaved(instance, event);
      });
      element?.addEventListener?.('input', event => instance.callbacks.onInputChange?.(event));
    }
    // Guardrails: live, non-blocking analysis of the protection globs.
    for (const selector of ['[data-governance-readonly-patterns]', '[data-governance-writable-patterns]']) {
      const element = container.querySelector(selector);
      element?.addEventListener?.('input', () => updateGovernanceNotes(instance));
      element?.addEventListener?.('change', () => updateGovernanceNotes(instance));
    }
    setupGroupPersistence(instance);

    return {
      show: () => show(instance),
      hide: () => hide(instance),
      loadState: state => loadState(instance, state),
      readState: () => readState(instance),
      setStatus: (text, status) => setStatus(instance, text, status),
      clearStatus: () => clearStatus(instance),
      setSkillsSummary: text => setSkillsSummary(instance, text),
      setProviderSummary: summary => setProviderSummary(instance, summary),
      refreshNotes: () => updateGovernanceNotes(instance),
      destroy: () => destroy(instance),
      _instance: instance
    };
  }

  function show(target) {
    const instance = target?._instance || target;
    const root = getRoot(instance);
    if (!root) {
      return;
    }
    const button = getButton(instance);
    if (button) {
      button.dataset.active = 'true';
      button.setAttribute('aria-expanded', 'true');
    }
    root.querySelector('[data-custom-instructions-input]')?.focus?.();
  }

  function hide(target) {
    const instance = target?._instance || target;
    const root = getRoot(instance);
    if (!root) {
      return;
    }
    const button = getButton(instance);
    if (button) {
      button.dataset.active = 'false';
      button.setAttribute('aria-expanded', 'false');
    }
    clearStatus(instance);
  }

  function isVisible(target) {
    const instance = target?._instance || target;
    // Visibility is governed by the panel root's data-view attribute. The
    // settings surface counts as visible for both the settings screen and the
    // skills sub-page, so the gear toggle can close either back to the session.
    const panelRoot = instance?.container?.closest?.('[data-view]') ||
      instance?.container?.ownerDocument?.querySelector?.('[data-view]');
    if (panelRoot) {
      return panelRoot.dataset.view === 'settings' || panelRoot.dataset.view === 'skills';
    }
    // Fallback: treat as not visible if we cannot read the view state.
    return false;
  }

  function loadState(target, state = {}) {
    const instance = target?._instance || target;
    const root = getRoot(instance);
    if (!root) {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(state, 'customInstructions')) {
      const input = root.querySelector('[data-custom-instructions-input]');
      if (input) {
        input.value = state.customInstructions || '';
      }
    }
    if (Object.prototype.hasOwnProperty.call(state, 'governanceRules')) {
      const rules = state.governanceRules || {};
      setValue(root, '[data-governance-readonly-patterns]', (rules.readonlyPatterns || []).join('\n'));
      setValue(root, '[data-governance-writable-patterns]', (rules.writablePatterns || []).join('\n'));
      setChecked(root, '[data-sensitive-check-enabled]', rules.sensitiveCheckEnabled !== false);
      setChecked(root, '[data-sensitive-confirm-allowed]', rules.sensitiveConfirmAllowed === true);
      updateGovernanceNotes(instance);
    }
    if (Object.prototype.hasOwnProperty.call(state, 'skillToggles')) {
      // The local-skills switch lives on the settings screen; the Codex Overleaf
      // master switch lives on the skills screen. Both are reachable from the
      // shared container, so query that instead of a single screen root.
      const scope = instance?.container || root;
      const toggles = state.skillToggles || {};
      setChecked(scope, '[data-preload-project-context]', toggles.preloadProjectContext !== false);
      setChecked(scope, '[data-load-codex-local-skills]', toggles.loadCodexLocalSkills !== false);
      setChecked(scope, '[data-load-codex-overleaf-skills]', toggles.loadCodexOverleafSkills !== false);
      setValue(scope, '[data-theme-select]', state.theme || 'dark');
      setValue(scope, '[data-language-select]', state.language || 'en');
    }
  }

  function readState(target) {
    const instance = target?._instance || target;
    const root = getRoot(instance);
    // Skill toggles span two screens, so read them from the shared container.
    const scope = instance?.container || root;
    return {
      customInstructions: root?.querySelector('[data-custom-instructions-input]')?.value || '',
      governanceRules: {
        readonlyPatterns: readPatternList(root?.querySelector('[data-governance-readonly-patterns]')?.value),
        writablePatterns: readPatternList(root?.querySelector('[data-governance-writable-patterns]')?.value),
        sensitiveCheckEnabled: root?.querySelector('[data-sensitive-check-enabled]')?.checked !== false,
        sensitiveConfirmAllowed: root?.querySelector('[data-sensitive-confirm-allowed]')?.checked === true
      },
      skillToggles: {
        preloadProjectContext: scope?.querySelector('[data-preload-project-context]')?.checked !== false,
        loadCodexLocalSkills: scope?.querySelector('[data-load-codex-local-skills]')?.checked !== false,
        loadCodexOverleafSkills: scope?.querySelector('[data-load-codex-overleaf-skills]')?.checked !== false
      },
      theme: scope?.querySelector('[data-theme-select]')?.value || 'dark',
      language: scope?.querySelector('[data-language-select]')?.value || 'en'
    };
  }

  function setStatus(target, text, status = 'info') {
    const instance = target?._instance || target;
    const element = getRoot(instance)?.querySelector('[data-project-settings-status]');
    if (!element) {
      return;
    }
    element.textContent = text || '';
    element.dataset.status = status;
  }

  function clearStatus(target) {
    const instance = target?._instance || target;
    const element = getRoot(instance)?.querySelector('[data-project-settings-status]');
    if (!element) {
      return;
    }
    element.textContent = '';
    delete element.dataset.status;
  }

  function setSkillsSummary(target, text) {
    const instance = target?._instance || target;
    const element = instance?.container?.querySelector('[data-skills-entry-summary]');
    if (!element) {
      return;
    }
    element.textContent = text || '';
  }

  // Flash the "✓ Saved" indicator after a field auto-saves, then fade it out.
  // The fields persist immediately on change, so this is purely a confirmation
  // cue — it never gates the save itself.
  function flashSaved(instance, event) {
    // Card-level feedback: the ✓ appears on the card that was actually
    // changed (falls back to the screen's first badge, e.g. the skills page).
    const origin = event?.target?.closest?.('details.codex-set-group, section');
    const badge = origin?.querySelector?.('[data-set-saved]')
      || instance?.container?.querySelector('[data-set-saved]');
    if (!badge) {
      return;
    }
    badge.hidden = false;
    if (badge._savedFlashTimer) {
      clearTimeout(badge._savedFlashTimer);
    }
    badge._savedFlashTimer = setTimeout(() => {
      badge.hidden = true;
    }, 1600);
  }

  function t(instance, key, params) {
    if (typeof instance?.i18n?.tr === 'function') {
      return instance.i18n.tr(key, params);
    }
    return key;
  }

  // Guardrail analysis for the protection globs: warn (never block) when a
  // read-only rule matches everything. Broadness is probed against the REAL
  // enforcement matcher (governanceRules.matchesGovernancePattern) so the
  // warning can neither cry wolf on inert patterns like './**' (which the
  // engine never matches) nor miss genuinely-total ones like '***'. Falls
  // back to a literal check when the module is absent (test harnesses).
  const BROAD_PROBE_PATHS = ['main.tex', 'sections/deep/chapter.tex'];

  function patternMatchesEverything(pattern) {
    const rules = (typeof window !== 'undefined' ? window : globalThis)?.CodexOverleafGovernanceRules;
    if (typeof rules?.matchesGovernancePattern === 'function') {
      return BROAD_PROBE_PATHS.every(path => rules.matchesGovernancePattern(path, pattern));
    }
    return pattern === '**' || pattern === '*';
  }

  function analyzePatternList(value) {
    const lines = String(value || '').split('\n').map(line => line.trim()).filter(Boolean);
    return {
      count: lines.length,
      broad: lines.find(line => patternMatchesEverything(line)) || ''
    };
  }

  function updateGovernanceNotes(instance) {
    const root = instance?.container;
    if (!root) {
      return;
    }
    const readonlyNote = root.querySelector('[data-governance-readonly-note]');
    const writableNote = root.querySelector('[data-governance-writable-note]');
    const readonly = analyzePatternList(root.querySelector('[data-governance-readonly-patterns]')?.value);
    const writable = analyzePatternList(root.querySelector('[data-governance-writable-patterns]')?.value);
    if (readonlyNote) {
      if (readonly.broad) {
        readonlyNote.dataset.tone = 'warn';
        readonlyNote.textContent = t(instance, 'governanceBroadReadonlyWarning', { pattern: readonly.broad });
        readonlyNote.hidden = false;
      } else {
        readonlyNote.hidden = true;
      }
    }
    if (writableNote) {
      if (writable.count > 0) {
        writableNote.dataset.tone = 'info';
        writableNote.textContent = t(instance, 'governanceWritableAllowlistNote');
        writableNote.hidden = false;
      } else {
        writableNote.hidden = true;
      }
    }
  }

  function setProviderSummary(instance, value = {}) {
    const element = instance?.container?.querySelector('[data-provider-settings-summary]');
    if (!element) {
      return;
    }
    element.textContent = typeof value === 'string' ? value : value.summary || '';
    element.dataset.tone = typeof value === 'object' && value.tone ? value.tone : 'ok';
  }

  // Collapse memory: card open/closed state persists per browser profile.
  const GROUP_STORE_KEY = 'codexOverleafSettingsGroups';

  function setupGroupPersistence(instance) {
    let stored = {};
    try {
      stored = JSON.parse(globalThis.localStorage?.getItem(GROUP_STORE_KEY) || '{}') || {};
    } catch (_error) {
      stored = {};
    }
    for (const details of instance.container.querySelectorAll('details[data-set-group]')) {
      const key = details.dataset.setGroup;
      if (key in stored) {
        details.open = stored[key] !== false;
      }
      details.addEventListener('toggle', () => {
        try {
          const current = JSON.parse(globalThis.localStorage?.getItem(GROUP_STORE_KEY) || '{}') || {};
          current[key] = details.open;
          globalThis.localStorage?.setItem(GROUP_STORE_KEY, JSON.stringify(current));
        } catch (_error) { /* private mode — collapse state just doesn't persist */ }
      });
    }
  }

  function getRoot(instance) {
    return instance?.container?.querySelector('[data-project-settings-panel]') || null;
  }

  function getButton(instance) {
    return instance?.button || document.querySelector('[data-custom-instructions-settings]');
  }

  function setValue(root, selector, value) {
    const element = root.querySelector(selector);
    if (element) {
      element.value = value;
    }
  }

  function setChecked(root, selector, checked) {
    const element = root.querySelector(selector);
    if (element) {
      element.checked = checked;
    }
  }

  function readPatternList(value) {
    return String(value || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  }

  function destroy(instance) {
    if (instance._savedFlashTimer) {
      clearTimeout(instance._savedFlashTimer);
      instance._savedFlashTimer = null;
    }
    instance.container.textContent = '';
  }

  window.CodexOverleafSettingsPanel = {
    create,
    loadState,
    readState,
    show,
    hide,
    isVisible,
    setStatus,
    clearStatus,
    setSkillsSummary,
    setProviderSummary
  };
})();
