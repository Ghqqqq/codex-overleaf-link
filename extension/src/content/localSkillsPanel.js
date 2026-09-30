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
    setState = () => {},
    saveState = null,
    sendBackgroundNative = () => Promise.resolve({ ok: false }),
    getSkillLoadingSettings = () => ({ loadCodexOverleafSkills: true }),
    isCodexOverleafSkillEnabled = () => true,
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

    async function refreshLocalSkills() {
      showSkillListLoading();
      try {
        const codexOverleafResponse = await sendBackgroundNative({
          method: 'skills.list',
          params: { scope: 'codex-overleaf' }
        });
        if (!codexOverleafResponse?.ok) {
          throw new Error(codexOverleafResponse?.error?.message || 'native host did not return Codex Overleaf skills');
        }
        const codexOverleafSkills = Array.isArray(codexOverleafResponse.result?.skills)
          ? codexOverleafResponse.result.skills
          : [];
        const state = getState() || {};
        setState({
          ...state,
          codexOverleafSkills
        });
        setSlashCodexOverleafSkills(codexOverleafSkills);
        renderLocalSkillList();
      } catch (err) {
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
      const list = getPanel()?.querySelector('[data-local-skill-list]');
      if (!list) {
        return;
      }
      confirmingRowId = null;
      const codexOverleafSkills = getCodexOverleafSkillsForSettings();
      const codexOverleafEnabled = getSkillLoadingSettings().loadCodexOverleafSkills !== false;
      list.textContent = '';
      if (!codexOverleafEnabled) {
        appendLocalSkillEmpty(list, tr('codexOverleafSkillsDisabled'));
      }
      if (!codexOverleafSkills.length) {
        appendLocalSkillEmpty(list, tr('codexOverleafSkillsEmpty'));
        return;
      }
      for (const skill of codexOverleafSkills) {
        renderCodexOverleafSkillRow(list, skill, codexOverleafEnabled);
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
      const compact = Boolean(list.closest?.('.codex-settings-workbench'));
      const row = document.createElement('div');
      row.className = 'codex-local-skill-row';
      row.dataset.scope = 'codex-overleaf';
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
      const description = descriptions[id]
        || (typeof skill.description === 'string' ? skill.description.replace(/\s+/g, ' ').trim() : '');
      if (description) {
        const help = document.createElement('span');
        help.className = 'codex-local-skill-description';
        help.textContent = description;
        help.title = description;
        copy.append(help);
      }
      if (compact) row.append(createSkillMark(id));
      row.append(copy);
      const controls = compact ? document.createElement('div') : row;
      if (compact) controls.className = 'codex-local-skill-controls';

      // Keep the same native input and callbacks; only its visual grouping changes.
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'codex-switch';
      toggle.checked = isCodexOverleafSkillEnabled(id);
      toggle.setAttribute('aria-label', (trimmedTitle || id) + ': ' + tr('codexOverleafSkillEnableToggle'));
      if (!masterEnabled) {
        toggle.disabled = true;
      }
      toggle.addEventListener('change', event => {
        setCodexOverleafSkillEnabled(id, event.target.checked);
      });

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

    function appendLocalSkillEmpty(list, text) {
      const empty = document.createElement('div');
      empty.className = 'codex-project-settings-empty';
      empty.textContent = text;
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
      if (activeSkill?.scope === 'codex-overleaf' && activeSkill.skillId === id) {
        clearComposerSkillInvocation();
      }
      setProjectSettingsStatus(tr('codexOverleafSkillRemoveDone'), 'completed');
      clearSlashCodexOverleafSkills();
      await refreshLocalSkills();
      await saveState?.();
    }

    return {
      refreshLocalSkills,
      renderLocalSkillList,
      removeCodexOverleafSkill
    };
  }

  return {
    createLocalSkillsPanelController
  };
});
