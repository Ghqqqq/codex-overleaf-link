(function initCodexOverleafProjectSettingsCoordinator() {
  'use strict';

  // Skill messages belong to the settings workbench page that holds the Skills group.
  const SKILLS_STATUS = Object.freeze({ page: 'context' });

  function create(deps = {}) {
    const {
      CodexOverleafTheme,
      GovernanceRules,
      SettingsPanel,
      closeContextTray,
      closeDiagnosticsMenu,
      closeDiagnosticsResult,
      closeModelConfigPopover,
      closeSlashMenu,
      getCurrentProjectId,
      getLocalSkillsPanel,
      getLocale,
      getPanel,
      getPanelRendererInstance,
      getSettingsPanelInstance,
      getState,
      isProjectEditorRoute,
      refreshStorageUsageSummary,
      renderAuditHistoryPanel,
      renderRecentProjectsVariant,
      saveStateSoon,
      setState,
      tr,
      tx,
      window
    } = deps;
    let customInstructionsEditorProjectId = '';
    let customInstructionsEditorValue = '';
    let themeAutoDisposer = null;

    function normalizeCustomInstructionsByProject(value) {
      const result = {};
      const textMaxChars = 12000;
      const keyMaxChars = 160;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return result;
      }
      for (const rawKey of Object.keys(value)) {
        const key = typeof rawKey === 'string' ? rawKey.trim() : '';
        if (!key) {
          continue;
        }
        const normalizedKey = key.length <= keyMaxChars ? key : key.slice(0, keyMaxChars - 1) + '…';
        const rawText = typeof value[rawKey] === 'string' ? value[rawKey] : '';
        result[normalizedKey] = rawText.length <= textMaxChars
          ? rawText
          : rawText.slice(0, textMaxChars - 1) + '…';
      }
      return result;
    }

    function getCustomInstructionsForCurrentProject() {
      const projectId = getCurrentProjectId();
      const normalizedProject = normalizeCustomInstructionsByProject({ [projectId]: '' });
      const normalizedProjectId = Object.keys(normalizedProject)[0] || '';
      if (!normalizedProjectId) {
        return '';
      }
      return normalizeCustomInstructionsByProject(getState()?.customInstructionsByProject)[normalizedProjectId] || '';
    }

    function setCustomInstructionsForProject(projectId, value) {
      const normalizedProject = normalizeCustomInstructionsByProject({ [projectId]: value });
      const normalizedProjectId = Object.keys(normalizedProject)[0] || '';
      if (!normalizedProjectId) {
        return;
      }
      setState({
        ...getState(),
        customInstructionsByProject: {
          ...normalizeCustomInstructionsByProject(getState()?.customInstructionsByProject),
          [normalizedProjectId]: normalizedProject[normalizedProjectId]
        }
      });
    }

    function openCustomInstructionsSettings() {
      const settingsPanelInstance = getSettingsPanelInstance();
      if (!settingsPanelInstance) {
        return;
      }
      closeDiagnosticsMenu();
      closeDiagnosticsResult();
      closeModelConfigPopover();
      closeContextTray();
      closeSlashMenu();
      clearProjectSettingsStatus();
      syncCustomInstructionsEditorForProject(getCurrentProjectId(), { force: true });
      syncProjectSettingsEditorForProject();
      getPanelRendererInstance()?.setView?.('settings');
      SettingsPanel.show(settingsPanelInstance);
      refreshStorageUsageSummary();
      if (settingsPanelInstance.container?.querySelector('[data-history-card]')?.open) {
        renderAuditHistoryPanel();
      }
      refreshLocalSkills().catch(error => setProjectSettingsStatus(tx(
        `Could not list local skills: ${error.message}`,
        `无法列出本地技能：${error.message}`
      ), 'failed', SKILLS_STATUS));
    }

    function toggleCustomInstructionsSettings() {
      if (SettingsPanel.isVisible(getSettingsPanelInstance())) {
        closeCustomInstructionsSettings();
        return;
      }
      openCustomInstructionsSettings();
    }

    function closeCustomInstructionsSettings() {
      SettingsPanel.hide(getSettingsPanelInstance());
      if (isProjectEditorRoute(window.location)) {
        getPanelRendererInstance()?.setView?.('session');
      } else {
        renderRecentProjectsVariant().catch(() => { /* swallow */ });
      }
    }

    function openSkillsView() {
      if (!getSettingsPanelInstance()) {
        return;
      }
      getPanelRendererInstance()?.setView?.('skills');
      refreshLocalSkills().catch(error => setProjectSettingsStatus(tx(
        `Could not list local skills: ${error.message}`,
        `无法列出本地技能：${error.message}`
      ), 'failed', SKILLS_STATUS));
    }

    function closeSkillsView() {
      getPanelRendererInstance()?.setView?.('settings');
    }

    function updateSkillsEntrySummary() {
      const settingsPanelInstance = getSettingsPanelInstance();
      if (!settingsPanelInstance) {
        return;
      }
      const settings = getSkillLoadingSettings();
      const localCount = settings.loadCodexLocalSkills === false ? 0
        : (deps.getCodexLocalSkills?.() || []).filter(skill => isCodexLocalSkillEnabled(skill.id, skill)).length;
      const overleafCount = settings.loadCodexOverleafSkills === false ? 0 : countEnabledCodexOverleafSkills();
      const summary = settings.loadCodexLocalSkills === false && settings.loadCodexOverleafSkills === false
        ? tr('codexOverleafSkillsSummaryOff')
        : tr('codexOverleafSkillsSummaryCount', { count: localCount + overleafCount });
      SettingsPanel.setSkillsSummary(settingsPanelInstance, summary);
    }

    function countEnabledCodexOverleafSkills() {
      const skills = Array.isArray(getState()?.codexOverleafSkills) ? getState().codexOverleafSkills : [];
      return skills.reduce((total, skill) => {
        const id = String(skill?.id || '').trim();
        return id && isCodexOverleafSkillEnabled(id) ? total + 1 : total;
      }, 0);
    }

    function syncCustomInstructionsEditorForProject(projectId = getCurrentProjectId(), options) {
      const syncOptions = options || {};
      const panel = getPanel();
      const input = panel?.querySelector('[data-custom-instructions-input]');
      if (!input) {
        return;
      }
      const normalizedProject = normalizeCustomInstructionsByProject({ [projectId]: '' });
      const normalizedProjectId = Object.keys(normalizedProject)[0] || '';
      const storedValue = normalizedProjectId
        ? normalizeCustomInstructionsByProject(getState()?.customInstructionsByProject)[normalizedProjectId] || ''
        : '';
      input.placeholder = tr('customInstructionsPlaceholder');
      const editorIsOpen = panel?.dataset?.view === 'settings' || panel?.dataset?.view === 'skills';
      const editorIsDirty = normalizedProjectId
        && customInstructionsEditorProjectId === normalizedProjectId
        && input.value !== customInstructionsEditorValue;
      if (!syncOptions.force && editorIsOpen && editorIsDirty) {
        return;
      }
      input.value = storedValue;
      customInstructionsEditorProjectId = normalizedProjectId;
      customInstructionsEditorValue = storedValue;
    }

    function normalizeGovernanceRulesByProject(value) {
      const result = {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return result;
      }
      for (const rawKey of Object.keys(value)) {
        const key = normalizeProjectPreferenceKey(rawKey);
        if (!key) {
          continue;
        }
        result[key] = normalizeGovernanceRules(value[rawKey]);
      }
      return result;
    }

    function normalizeProjectPreferenceKey(value) {
      const text = String(value || '').trim();
      return text.length <= 160 ? text : text.slice(0, 159) + '…';
    }

    function normalizeGovernanceRules(value = {}) {
      if (GovernanceRules?.normalizeGovernanceRules) {
        return GovernanceRules.normalizeGovernanceRules(value);
      }
      return {
        readonlyPatterns: normalizePatternTextList(value.readonlyPatterns),
        writablePatterns: normalizePatternTextList(value.writablePatterns),
        sensitiveCheckEnabled: value.sensitiveCheckEnabled !== false,
        sensitiveConfirmAllowed: value.sensitiveConfirmAllowed === true
      };
    }

    function normalizePatternTextList(value) {
      if (Array.isArray(value)) {
        return value.map(item => String(item || '').trim()).filter(Boolean);
      }
      return String(value || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    }

    function getGovernanceRulesForCurrentProject() {
      const projectId = normalizeProjectPreferenceKey(getCurrentProjectId());
      return normalizeGovernanceRulesByProject(getState()?.governanceRulesByProject)[projectId]
        || normalizeGovernanceRules({});
    }

    function setGovernanceRulesForCurrentProject(rules) {
      const projectId = normalizeProjectPreferenceKey(getCurrentProjectId());
      if (!projectId) {
        return;
      }
      setState({
        ...getState(),
        governanceRulesByProject: {
          ...normalizeGovernanceRulesByProject(getState()?.governanceRulesByProject),
          [projectId]: normalizeGovernanceRules(rules)
        }
      });
    }

    function getThemePreference() {
      return CodexOverleafTheme.normalizeThemePreference(getState()?.theme);
    }

    function applyPanelTheme(preference) {
      const normalized = CodexOverleafTheme.normalizeThemePreference(preference);
      CodexOverleafTheme.applyTheme(normalized, getPanel());
      if (themeAutoDisposer) {
        themeAutoDisposer();
        themeAutoDisposer = null;
      }
      themeAutoDisposer = CodexOverleafTheme.watchAuto(normalized, getPanel());
    }

    function getSkillLoadingSettings() {
      return {
        preloadProjectContext: getState()?.preloadProjectContext !== false,
        loadCodexLocalSkills: getState()?.loadCodexLocalSkills !== false,
        loadCodexOverleafSkills: getState()?.loadCodexOverleafSkills !== false
      };
    }

    function setSkillLoadingSettings(settings = {}) {
      setState({
        ...getState(),
        preloadProjectContext: settings.preloadProjectContext !== false,
        loadCodexLocalSkills: settings.loadCodexLocalSkills !== false,
        loadCodexOverleafSkills: settings.loadCodexOverleafSkills !== false
      });
    }

    function getCodexOverleafSkillEnabled() {
      const map = getState()?.codexOverleafSkillEnabled;
      return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    }

    function isCodexOverleafSkillEnabled(skillId) {
      const map = getCodexOverleafSkillEnabled();
      if (!Object.prototype.hasOwnProperty.call(map, skillId)) {
        return true;
      }
      return map[skillId] !== false;
    }

    function setCodexOverleafSkillEnabled(skillId, enabled) {
      const map = getCodexOverleafSkillEnabled();
      setState({
        ...getState(),
        codexOverleafSkillEnabled: {
          ...map,
          [skillId]: Boolean(enabled)
        }
      });
      saveStateSoon();
      renderLocalSkillList();
      deps.updateGlobalPreferences?.({ codexOverleafSkillEnabled: { [skillId]: Boolean(enabled) } })?.catch(() => {});
    }

    function getCodexLocalSkillEnabled() {
      const map = getState()?.codexLocalSkillEnabled;
      return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    }

    function isCodexLocalSkillEnabled(skillId, skill) {
      const map = getCodexLocalSkillEnabled();
      return Object.prototype.hasOwnProperty.call(map, skillId) ? map[skillId] !== false : skill?.enabled !== false;
    }

    function setCodexLocalSkillEnabled(skillId, enabled) {
      if (deps.updateGlobalPreferences) {
        try {
          const pending = deps.updateGlobalPreferences({ codexLocalSkillEnabled: { [skillId]: Boolean(enabled) } });
          Promise.resolve(pending).then(() => saveStateSoon()).catch(() => {
            renderLocalSkillList();
            setProjectSettingsStatus(tx('Could not save the local skill selection. Try again.', '无法保存本地技能选择，请重试。'), 'failed', SKILLS_STATUS);
          });
        } catch (_error) {
          renderLocalSkillList();
          setProjectSettingsStatus(tx('Could not save the local skill selection. Try again.', '无法保存本地技能选择，请重试。'), 'failed', SKILLS_STATUS);
        }
      } else {
        setState({ ...getState(), codexLocalSkillEnabled: { ...getCodexLocalSkillEnabled(), [skillId]: Boolean(enabled) } });
        saveStateSoon();
        renderLocalSkillList();
      }
      deps.onSkillsChange?.();
    }

    function readSkillLoadingSettingsFromSettings() {
      return SettingsPanel.readState(getSettingsPanelInstance()).skillToggles;
    }

    function readGovernanceRulesFromSettings() {
      return normalizeGovernanceRules(SettingsPanel.readState(getSettingsPanelInstance()).governanceRules);
    }

    function syncProjectSettingsEditorForProject() {
      SettingsPanel.loadState(getSettingsPanelInstance(), {
        governanceRules: getGovernanceRulesForCurrentProject(),
        skillToggles: getSkillLoadingSettings(),
        theme: getThemePreference(),
        language: getLocale()
      });
      renderLocalSkillList();
    }

    function setProjectSettingsStatus(text, status = 'info', options) {
      SettingsPanel.setStatus(getSettingsPanelInstance(), text, status, options);
    }

    function clearProjectSettingsStatus() {
      SettingsPanel.clearStatus(getSettingsPanelInstance());
    }

    async function refreshLocalSkills() {
      return getLocalSkillsPanel().refreshLocalSkills();
    }

    function renderLocalSkillList() {
      getLocalSkillsPanel().renderLocalSkillList();
      updateSkillsEntrySummary();
    }

    return {
      applyPanelTheme,
      clearProjectSettingsStatus,
      closeCustomInstructionsSettings,
      closeSkillsView,
      getCodexOverleafSkillEnabled,
      getCodexLocalSkillEnabled,
      isCodexLocalSkillEnabled,
      setCodexLocalSkillEnabled,
      getCustomInstructionsForCurrentProject,
      getGovernanceRulesForCurrentProject,
      getSkillLoadingSettings,
      getThemePreference,
      isCodexOverleafSkillEnabled,
      normalizeCustomInstructionsByProject,
      normalizeGovernanceRules,
      normalizeGovernanceRulesByProject,
      normalizeProjectPreferenceKey,
      openCustomInstructionsSettings,
      openSkillsView,
      readGovernanceRulesFromSettings,
      readSkillLoadingSettingsFromSettings,
      refreshLocalSkills,
      renderLocalSkillList,
      setCodexOverleafSkillEnabled,
      setCustomInstructionsForProject,
      setGovernanceRulesForCurrentProject,
      setProjectSettingsStatus,
      setSkillLoadingSettings,
      syncCustomInstructionsEditorForProject,
      syncProjectSettingsEditorForProject,
      toggleCustomInstructionsSettings,
      updateSkillsEntrySummary
    };
  }

  window.CodexOverleafProjectSettingsCoordinator = { create };
})();
