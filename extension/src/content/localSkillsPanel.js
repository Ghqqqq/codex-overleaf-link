(function initCodexOverleafLocalSkillsPanel(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafLocalSkillsPanel = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function localSkillsPanelFactory() {
  'use strict';

  // Destructuring defaults handle the "dep omitted" case. Production callers
  // pass real functions; tests that exercise partial wiring rely on the
  // undefined-only defaults to land on the noop. Passing `null` or a non-
  // function value is no longer silently coerced — that was an antipattern
  // (the typeof guards used to hide a missing wire-up by swapping in a noop).
  function createLocalSkillsPanelController({
    root = (typeof window !== 'undefined' ? window : globalThis),
    document: documentDep = null,
    getPanel = () => null,
    getState = () => null,
    getScope = () => '',
    setState = () => {},
    saveState = null,
    sendBackgroundNative = () => Promise.resolve({ ok: false }),
    getSkillLoadingSettings = () => ({ loadCodexOverleafSkills: true }),
    isCodexOverleafSkillEnabled = () => true,
    isCodexLocalSkillEnabled = (id, skill) => skill?.enabled !== false,
    setCodexLocalSkillEnabled = () => {},
    getCodexLocalSkills = () => [],
    getCodexLocalSkillWarnings = () => [],
    refreshCodexLocalSkills = async () => [],
    setCodexOverleafSkillEnabled = () => {},
    setProjectSettingsStatus = () => {},
    tr = (key) => key,
    tx = (english) => english,
    getComposerSkillInvocation = () => null,
    normalizeComposerSkillInvocation = (value) => value,
    clearComposerSkillInvocation = () => {},
    setSlashCodexOverleafSkills = () => {},
    clearSlashCodexOverleafSkills = () => {}
  } = {}) {
    const document = documentDep
      || root.document
      || (typeof globalThis !== 'undefined' ? globalThis.document : null);

    let localSkillsListError = false;
    let refreshGeneration = 0;
    async function refreshLocalSkills() {
      const generation = ++refreshGeneration;
      const scope = getScope();
      const isCurrent = () => generation === refreshGeneration && scope === getScope();
      localSkillsListError = false;
      showSkillListLoading();
      const localList = getPanel()?.querySelector('[data-codex-local-skill-list]');
      if (localList) {
        localList.textContent = '';
        appendLocalSkillEmpty(localList, 'codexOverleafSkillsLoading');
      }
      const localRefresh = localList ? refreshCodexLocalSkills({ force: true }) : Promise.resolve([]);
      const localOutcome = localRefresh.then(() => {
        if (isCurrent()) renderCodexLocalSkillList();
        return null;
      }, error => {
        if (isCurrent()) { localSkillsListError = true; renderCodexLocalSkillList(); }
        return error;
      });
      try {
        const codexOverleafResponse = await sendBackgroundNative({
          method: 'skills.list',
          params: { scope: 'codex-overleaf' }
        });
        if (!codexOverleafResponse?.ok) {
          throw new Error(tx('Could not load Codex Overleaf skills. Try again.', '无法加载 Codex Overleaf 技能，请重试。'));
        }
        const codexOverleafSkills = Array.isArray(codexOverleafResponse.result?.skills)
          ? codexOverleafResponse.result.skills
          : [];
        if (!isCurrent()) return;
        const state = getState() || {};
        setState({
          ...state,
          codexOverleafSkills
        });
        setSlashCodexOverleafSkills(codexOverleafSkills);
        const localError = await localOutcome;
        if (!isCurrent()) return;
        renderLocalSkillList();
        if (localError) throw localError;
      } catch (err) {
        if (!isCurrent()) return;
        renderLocalSkillList();
        throw err;
      }
    }

    function showSkillListLoading() {
      const list = getPanel()?.querySelector('[data-local-skill-list]');
      if (!list) {
        return;
      }
      list.textContent = '';
      const placeholder = document.createElement('div');
      placeholder.className = 'codex-project-settings-empty';
      placeholder.textContent = tr('codexOverleafSkillsLoading');
      placeholder.dataset.i18n = 'codexOverleafSkillsLoading';
      list.append(placeholder);
    }

    // Tracks which row is currently in "confirming remove" state.
    // Only one row may be in this state at a time.
    let confirmingRowId = null;

    function getCodexOverleafSkillsForSettings() {
      const state = getState() || {};
      return Array.isArray(state.codexOverleafSkills) ? state.codexOverleafSkills : [];
    }

    function renderLocalSkillList() {
      renderCodexLocalSkillList();
      const list = getPanel()?.querySelector('[data-local-skill-list]');
      if (!list) {
        return;
      }
      confirmingRowId = null;
      const codexOverleafSkills = getCodexOverleafSkillsForSettings();
      const codexOverleafEnabled = getSkillLoadingSettings().loadCodexOverleafSkills !== false;
      list.textContent = '';
      if (!codexOverleafEnabled) {
        appendLocalSkillEmpty(list, 'codexOverleafSkillsDisabled');
      }
      if (!codexOverleafSkills.length) {
        appendLocalSkillEmpty(list, 'codexOverleafSkillsEmpty');
        return;
      }
      for (const skill of codexOverleafSkills) {
        renderCodexOverleafSkillRow(list, skill, codexOverleafEnabled);
      }
    }

    function renderCodexLocalSkillList() {
      const list = getPanel()?.querySelector('[data-codex-local-skill-list]');
      if (!list) return;
      list.textContent = '';
      const enabled = getSkillLoadingSettings().loadCodexLocalSkills !== false;
      if (!enabled) appendLocalSkillEmpty(list, 'codexLocalSkillsDisabled');
      const skills = getCodexLocalSkills();
      if (localSkillsListError) { appendLocalSkillEmpty(list, 'codexLocalSkillsLoadFailed'); return; }
      if (!Array.isArray(skills)) { appendLocalSkillEmpty(list, 'codexOverleafSkillsLoading'); return; }
      if (!skills.length) appendLocalSkillEmpty(list, 'codexLocalSkillsEmpty');
      const skippedCount = getCodexLocalSkillWarnings().reduce((sum, warning) => sum + (warning?.code === 'codex_local_skills_skipped' ? warning.count : 0), 0);
      if (skippedCount > 0) {
        const warning = document.createElement('div');
        warning.className = 'codex-project-settings-empty';
        warning._refreshLocale = () => { warning.textContent = tr('codexLocalSkillsSkipped', { count: skippedCount }); };
        warning._refreshLocale();
        list.append(warning);
      }
      for (const skill of skills) {
        const title = String(skill.title || skill.name || skill.id).trim();
        const duplicateTitle = skills.filter(other => String(other.title || other.name || other.id).trim() === title).length > 1;
        renderCodexOverleafSkillRow(list, { ...skill, title, duplicateTitle, scope: 'codex-local', removable: false }, enabled);
      }
    }

    function createSkillMark(id) {
      const mark = document.createElement('span');
      mark.className = 'codex-local-skill-icon';
      mark.setAttribute('aria-hidden', 'true');
      // Static, locally owned glyphs only; skill metadata never supplies SVG.
      const glyph = id === 'annotated-rewrite'
        ? '<path d="M3.2 12.8 4 9.7l6.6-6.6a1.4 1.4 0 0 1 2 2L6 11.7z"/><path d="m9.6 4.1 2.3 2.3"/>'
        : id === 'parallel-subagents'
          ? '<circle cx="4" cy="3.5" r="1.75"/><circle cx="12" cy="3.5" r="1.75"/><circle cx="8" cy="12.5" r="1.75"/><path d="M4 5.25v1.5A1.75 1.75 0 0 0 5.75 8.5h4.5A1.75 1.75 0 0 0 12 6.75v-1.5M8 8.5v2.25"/>'
          : '<rect x="3" y="2.5" width="10" height="11" rx="2"/><path d="M6 6h4M6 9h4"/>';
      mark.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" focusable="false">' + glyph + '</svg>';
      return mark;
    }

    function renderCodexOverleafSkillRow(list, skill, masterEnabled) {
      const id = String(skill?.id || '').trim();
      if (!id) {
        return;
      }
      const local = skill.scope === 'codex-local';
      const compact = Boolean(list.closest?.('.codex-settings-workbench'));
      const row = document.createElement('div');
      row.className = 'codex-local-skill-row';
      row.dataset.scope = local ? 'codex-local' : 'codex-overleaf';
      if (!masterEnabled) {
        row.dataset.disabled = 'true';
      }

      // Skill display name on the left — a single human-readable label
      // (title when available, else the id). Avoids redundant "Title (id)"
      // form per user feedback: one canonical name. The id remains as the
      // accessible `title` tooltip so the underlying identifier is still
      // discoverable on hover for advanced users.
      const text = document.createElement('span');
      const trimmedTitle = typeof skill.title === 'string' ? skill.title.trim() : '';
      text.textContent = trimmedTitle || id;
      text.title = id;
      text.className = 'codex-local-skill-name';
      const copy = document.createElement('div');
      copy.className = 'codex-local-skill-copy';
      copy.append(text);
      const descriptions = {
        'annotated-rewrite': tx('Guided editing for document revisions.', '用于文稿修订的编辑流程。'),
        'parallel-subagents': tx('Split independent subtasks across multiple agents.', '将相互独立的子任务分配给多个 agent。')
      };
      const description = (!local && descriptions[id])
        || (typeof skill.description === 'string' ? skill.description.replace(/\s+/g, ' ').trim() : '');
      if (description) {
        const help = document.createElement('span');
        help.className = 'codex-local-skill-description';
        help.textContent = description;
        help.title = description;
        copy.append(help);
      }
      const sourceText = () => (skill.sourceKind === 'system' ? tx('Codex built-in', 'Codex 内置')
        : skill.sourceKind === 'plugin' && skill.sourceLabel ? String(skill.sourceLabel) : tx('Local Codex', 'Codex 本地'))
        + (skill.duplicateTitle ? ' · ' + (skill.sourceHint || id.slice(-8)) : '');
      let sourceLabel = null;
      if (local) {
        sourceLabel = document.createElement('span');
        sourceLabel.className = 'codex-local-skill-description';
        sourceLabel.textContent = sourceText();
        copy.append(sourceLabel);
      }
      if (compact) row.append(createSkillMark(local ? '' : id));
      row.append(copy);
      const controls = compact ? document.createElement('div') : row;
      if (compact) controls.className = 'codex-local-skill-controls';

      // Keep the same native input and callbacks; only its visual grouping changes.
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'codex-switch';
      toggle.checked = local ? isCodexLocalSkillEnabled(id, skill) : isCodexOverleafSkillEnabled(id);
      const accessibleSkillName = (trimmedTitle || id)
        + (local && skill.duplicateTitle ? ': ' + (skill.sourceHint || id.slice(-8)) : '');
      toggle.setAttribute('aria-label', accessibleSkillName + ': ' + tr('codexOverleafSkillEnableToggle'));
      if (!masterEnabled) {
        toggle.disabled = true;
      }
      toggle.addEventListener('change', event => {
        if (local) setCodexLocalSkillEnabled(id, event.target.checked);
        else setCodexOverleafSkillEnabled(id, event.target.checked);
      });
      row._refreshLocale = () => {
        if (sourceLabel) sourceLabel.textContent = sourceText();
        toggle.setAttribute('aria-label', accessibleSkillName + ': ' + tr('codexOverleafSkillEnableToggle'));
        const label = !local && id === 'annotated-rewrite' ? tx('Guided editing for document revisions.', '用于文稿修订的编辑流程。')
          : !local && id === 'parallel-subagents' ? tx('Split independent subtasks across multiple agents.', '将相互独立的子任务分配给多个 agent。') : '';
        const help = copy.querySelector('.codex-local-skill-description');
        if (label && help) { help.textContent = label; help.title = label; }
      };

      if (skill.removable !== false) {
        // The Remove / Confirm / Cancel controls share an actions container so
        // the per-skill switch always stays rightmost in the row, regardless of
        // the inline confirmation state.
        const actions = document.createElement('div');
        actions.className = 'codex-local-skill-actions';

        // Remove button — clicking it enters the inline confirmation state.
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'codex-set-btn codex-set-btn--subtle';
        removeBtn.textContent = tr('localSkillRemove');

        // Confirm and Cancel buttons — only in the DOM while confirming.
        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'codex-set-btn codex-set-btn--danger';
        confirmBtn.textContent = tr('localSkillRemoveConfirm');

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'codex-set-btn';
        cancelBtn.textContent = tr('localSkillRemoveCancel');
        const refreshRow = row._refreshLocale;
        row._refreshLocale = () => {
          refreshRow(); removeBtn.textContent = tr('localSkillRemove'); cancelBtn.textContent = tr('localSkillRemoveCancel');
          confirmBtn.textContent = tr(confirmBtn.disabled ? 'localSkillRemoving' : 'localSkillRemoveConfirm');
        };

        function enterConfirming() {
          // Reset any previously confirming row back to its Remove button state.
          if (confirmingRowId !== null && confirmingRowId !== id) {
            resetConfirmingRow();
          }
          confirmingRowId = id;
          removeBtn.remove();
          row.dataset.confirming = 'true';
          actions.append(confirmBtn, cancelBtn);
        }

        function exitConfirming() {
          confirmingRowId = null;
          confirmBtn.remove();
          cancelBtn.remove();
          delete row.dataset.confirming;
          actions.append(removeBtn);
        }

        removeBtn.addEventListener('click', event => {
          event.preventDefault();
          enterConfirming();
        });

        cancelBtn.addEventListener('click', event => {
          event.preventDefault();
          exitConfirming();
        });

        confirmBtn.addEventListener('click', event => {
          event.preventDefault();
          // In-progress: disable Confirm, Cancel, and the enable toggle; update text.
          confirmBtn.disabled = true;
          cancelBtn.disabled = true;
          toggle.disabled = true;
          confirmBtn.textContent = tr('localSkillRemoving');
          removeCodexOverleafSkill(id).catch(error => {
            setProjectSettingsStatus(tx(`Failed to remove Codex Overleaf skill: ${error.message}`, `删除 Codex Overleaf 技能失败：${error.message}`), 'failed');
            // Restore row on failure so the user can retry.
            confirmBtn.disabled = false;
            cancelBtn.disabled = false;
            toggle.disabled = !masterEnabled;
            confirmBtn.textContent = tr('localSkillRemoveConfirm');
          });
        });

        actions.append(removeBtn);
        controls.append(actions);

        // Store references so resetConfirmingRow can find and reset this row.
        row._exitConfirming = exitConfirming;
        row._skillId = id;
      }

      // The switch remains rightmost, including during removal confirmation.
      controls.append(toggle);
      if (compact) row.append(controls);

      list.append(row);
    }

    function resetConfirmingRow() {
      // Walk the skill list to find the row whose id matches confirmingRowId.
      const list = getPanel()?.querySelector('[data-local-skill-list]');
      if (!list) {
        return;
      }
      for (const child of Array.from(list.children || [])) {
        if (child._skillId === confirmingRowId && child._exitConfirming) {
          child._exitConfirming();
          break;
        }
      }
    }

    function appendLocalSkillEmpty(list, key) {
      const empty = document.createElement('div');
      empty.className = 'codex-project-settings-empty';
      empty.textContent = tr(key);
      empty.dataset.i18n = key;
      list.append(empty);
    }

    async function removeCodexOverleafSkill(id) {
      const response = await sendBackgroundNative({
        method: 'skills.remove',
        params: {
          scope: 'codex-overleaf',
          id
        }
      });
      if (!response?.ok) {
        throw new Error(response?.error?.message || 'native host did not remove Codex Overleaf skill');
      }
      const activeSkill = normalizeComposerSkillInvocation(getComposerSkillInvocation());
      if (activeSkill?.scope === 'codex-overleaf' && activeSkill.id === id) {
        clearComposerSkillInvocation();
      }
      setProjectSettingsStatus(tr('codexOverleafSkillRemoveDone'), 'completed');
      clearSlashCodexOverleafSkills();
      await refreshLocalSkills();
      await saveState?.();
    }

    return {
      refreshLocalSkills,
      refreshLocale: () => {
        for (const selector of ['[data-local-skill-list]', '[data-codex-local-skill-list]']) {
          for (const row of getPanel()?.querySelector(selector)?.children || []) row._refreshLocale?.();
        }
      },
      renderLocalSkillList,
      removeCodexOverleafSkill
    };
  }

  return {
    createLocalSkillsPanelController
  };
});
