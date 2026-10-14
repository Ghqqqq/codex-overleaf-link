(function initCodexOverleafSessionMenuView() {
  'use strict';

  function create(deps = {}) {
    const {
      commitSessionRename,
      deleteSessionWithConfirm,
      document,
      formatSessionTime,
      getActiveSession,
      getPanel,
      getSessionDisplayTitle,
      getState,
      icons = null,
      isDisplayableSession,
      isSessionRunning,
      startNewSession,
      switchSession,
      tr
    } = deps;

    function applySessionLabel() {
      const trigger = getPanel().querySelector('[data-session-menu-trigger]');
      const textNode = getPanel().querySelector('[data-session-label-text]');
      const deleteButton = getPanel().querySelector('[data-session-delete]');
      const renameButton = getPanel().querySelector('[data-session-rename]');
      const renameInput = getPanel().querySelector('[data-session-rename-input]');
      const active = getActiveSession(getState());
      const label = active && isDisplayableSession(active)
        ? getSessionDisplayTitle(active)
        : tr('newSessionFallback');
      if (textNode) {
        textNode.textContent = label;
      }
      if (trigger) {
        trigger.title = `${label} · ${tr('sessionMenuOpen')}`;
        trigger.setAttribute('aria-label', `${tr('sessionMenuOpen')}: ${label}`);
      }
      if (deleteButton) {
        const running = active ? isSessionRunning(active) : false;
        const soleEmpty = Boolean(active) && !isDisplayableSession(active) && (getState()?.sessions || []).length <= 1;
        deleteButton.disabled = !active || running || soleEmpty;
        deleteButton.title = running ? tr('deleteRunningSession') : tr('deleteSession');
        deleteButton.setAttribute('aria-label', running ? tr('deleteRunningSession') : tr('deleteSession'));
      }
      if (renameButton) {
        renameButton.title = tr('renameSession');
        renameButton.setAttribute('aria-label', tr('renameSession'));
      }
      renameInput?.setAttribute('aria-label', tr('renameSession'));
    }

    function bindActiveSessionHeader() {
      getPanel().querySelector('[data-session-delete]')?.addEventListener('click', event => {
        event.stopPropagation();
        if (getState()?.activeSessionId) {
          deleteSessionWithConfirm(getState().activeSessionId);
        }
      });
      getPanel().querySelector('[data-session-rename]')?.addEventListener('click', event => {
        event.stopPropagation();
        beginActiveSessionRename();
      });
      getPanel().querySelector('[data-session-menu-trigger]')?.addEventListener('click', event => {
        event.stopPropagation();
        toggleSessionMenu();
      });
      document.addEventListener('click', event => {
        const menu = getPanel()?.querySelector('[data-session-menu]');
        if (!menu || menu.hidden) {
          return;
        }
        const trigger = getPanel()?.querySelector('[data-session-menu-trigger]');
        if (menu.contains(event.target) || trigger?.contains(event.target)) {
          return;
        }
        closeSessionMenu();
      }, true);
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          closeSessionMenu();
        }
      }, true);
    }

    function toggleSessionMenu() {
      const menu = getPanel()?.querySelector('[data-session-menu]');
      if (!menu) {
        return;
      }
      if (menu.hidden) {
        renderSessionMenu(menu);
      }
      menu.hidden = !menu.hidden;
      getPanel()?.querySelector('[data-session-menu-trigger]')
        ?.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
    }

    function closeSessionMenu() {
      const menu = getPanel()?.querySelector('[data-session-menu]');
      if (!menu || menu.hidden) {
        return;
      }
      menu.hidden = true;
      getPanel()?.querySelector('[data-session-menu-trigger]')?.setAttribute('aria-expanded', 'false');
    }

    function renderSessionMenu(menu) {
      menu.replaceChildren();
      const state = getState();
      const sessions = (state?.sessions || [])
        .filter(isDisplayableSession)
        .slice()
        .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
      for (const session of sessions) {
        const row = document.createElement('div');
        row.className = 'codex-session-menu-item';
        row.setAttribute('role', 'none');
        row.dataset.active = session.id === state?.activeSessionId ? 'true' : 'false';
        row.dataset.running = isSessionRunning(session) ? 'true' : 'false';
        const switchButton = document.createElement('button');
        switchButton.type = 'button';
        switchButton.className = 'codex-session-menu-switch';
        switchButton.setAttribute('role', 'menuitem');
        const title = document.createElement('span');
        title.className = 'codex-session-menu-item-title';
        title.textContent = getSessionDisplayTitle(session);
        title.title = getSessionDisplayTitle(session);
        const time = document.createElement('time');
        time.className = 'codex-session-menu-item-time';
        time.textContent = formatSessionTime(session.updatedAt || session.createdAt);
        const absoluteTs = session.updatedAt || session.createdAt;
        if (absoluteTs) {
          time.title = new Date(absoluteTs).toLocaleString();
        }
        switchButton.append(title, time);
        switchButton.addEventListener('click', event => {
          event.stopPropagation();
          closeSessionMenu();
          if (session.id !== getState()?.activeSessionId) {
            switchSession(session.id);
          }
        });
        const deleteButton = menuAction('codex-session-menu-item-delete', 'close', '',
          row.dataset.running === 'true' ? tr('deleteRunningSession') : tr('deleteSession'),
          () => deleteSessionWithConfirm(session.id));
        deleteButton.setAttribute('role', 'menuitem');
        deleteButton.disabled = row.dataset.running === 'true';
        row.append(switchButton, deleteButton);
        menu.append(row);
      }
      const footer = document.createElement('div');
      footer.className = 'codex-session-menu-footer';
      const active = getActiveSession(state);
      const running = active ? isSessionRunning(active) : false;
      const soleEmpty = Boolean(active) && !isDisplayableSession(active) && (state?.sessions || []).length <= 1;
      const createButton = menuAction('codex-session-menu-new', 'plus', tr('sessionMenuNewShort'), tr('newSession'), () => startNewSession());
      const renameButton = menuAction('codex-session-menu-rename', 'pencil', tr('sessionMenuRenameShort'), tr('renameSession'), () => beginActiveSessionRename());
      renameButton.disabled = !active;
      const deleteButton = menuAction('codex-session-menu-delete', 'close', tr('sessionMenuDeleteShort'),
        running ? tr('deleteRunningSession') : tr('deleteSession'), () => {
          if (getState()?.activeSessionId) deleteSessionWithConfirm(getState().activeSessionId);
        });
      deleteButton.disabled = !active || running || soleEmpty;
      footer.append(createButton, renameButton, deleteButton);
      menu.append(footer);
    }

    function menuAction(className, iconName, label, description, onSelect) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.title = description;
      button.setAttribute('aria-label', description);
      const glyph = icons?.svg?.(iconName);
      if (glyph) button.insertAdjacentHTML('beforeend', glyph);
      const text = document.createElement('span');
      text.textContent = label;
      button.append(text);
      button.addEventListener('click', event => {
        event.stopPropagation();
        closeSessionMenu();
        onSelect();
      });
      return button;
    }

    function beginActiveSessionRename() {
      const active = getActiveSession(getState());
      const wrap = getPanel().querySelector('[data-session-label]');
      const trigger = getPanel().querySelector('[data-session-menu-trigger]');
      const textNode = getPanel().querySelector('[data-session-label-text]');
      const input = getPanel().querySelector('[data-session-rename-input]');
      if (!active || !wrap || !textNode || !input) {
        return;
      }
      closeSessionMenu();
      let settled = false;
      wrap.dataset.editing = 'true';
      const seed = isDisplayableSession(active) ? getSessionDisplayTitle(active) : '';
      input.value = seed;
      input.hidden = false;
      textNode.hidden = true;
      if (trigger) {
        trigger.hidden = true;
      }
      input.focus();
      input.select();
      const cleanup = () => {
        input.removeEventListener('keydown', onKeydown);
        input.removeEventListener('blur', onBlur);
      };
      const finish = commit => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        input.hidden = true;
        textNode.hidden = false;
        if (trigger) {
          trigger.hidden = false;
        }
        delete wrap.dataset.editing;
        if (commit && input.value.trim() !== seed.trim()) {
          commitSessionRename(active.id, input.value);
        }
      };
      const onKeydown = event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      };
      const onBlur = () => finish(true);
      input.addEventListener('keydown', onKeydown);
      input.addEventListener('blur', onBlur);
    }

    return {
      applySessionLabel,
      beginActiveSessionRename,
      bindActiveSessionHeader,
      closeSessionMenu,
      renderSessionMenu,
      toggleSessionMenu
    };
  }

  window.CodexOverleafSessionMenuView = { create };
})();
