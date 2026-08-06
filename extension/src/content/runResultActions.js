(function initCodexOverleafRunResultActions(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafRunResultActions = api;
})(typeof window !== 'undefined' ? window : globalThis, function runResultActionsFactory() {
  'use strict';

  function create(deps = {}) {
    const {
      tr,
      getLocale,
      forkRunFromNode,
      document: documentRef = globalThis.document,
      navigator: navigatorRef = globalThis.navigator
    } = deps;

    function configureResultActions(root, run) {
      const actions = root.querySelector('.run-result-actions');
      const reports = root.querySelectorAll('.run-completion-report');
      const report = reports[reports.length - 1];
      if (!actions || !report) return;
      report.append(actions);
      actions.hidden = false;
      configureCopyButton(root);
      configureForkButton(root, run);
      configureCompletedTime(actions, run);
    }

    function configureForkButton(root, run) {
      const existing = root.querySelector('[data-run-fork]');
      const button = existing.cloneNode(true);
      existing.replaceWith(button);
      const available = run.forkSnapshot !== true
        && run.status !== 'running'
        && Boolean(run.codexTurnId)
        && typeof forkRunFromNode === 'function';
      button.hidden = false;
      button.disabled = !available;
      button.title = tr(available ? 'forkRunTitle' : 'forkRunUnavailable');
      button.setAttribute('aria-label', button.title);
      button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h3.5c3.5 0 4.2-4 7.5-4h2m-2.5-2.5L16 6l-2.5 2.5M6.5 10c3.5 0 4.2 4 7.5 4h2m-2.5-2.5L16 14l-2.5 2.5"/></svg>';
      if (!available) return;
      button.addEventListener('click', async event => {
        event.stopPropagation();
        button.disabled = true;
        button.classList.add('is-running');
        try {
          await forkRunFromNode(run.id);
        } catch (_error) {
          button.disabled = false;
          button.classList.remove('is-running');
        }
      });
    }

    function configureCompletedTime(actions, run) {
      const target = actions.querySelector('[data-run-completed-time]');
      const finishedAt = String(run.finishedAt || '').trim();
      const date = finishedAt ? new Date(finishedAt) : null;
      if (!target || !date || !Number.isFinite(date.getTime())) return;
      target.hidden = false;
      target.textContent = new Intl.DateTimeFormat(getLocale(), {
        hour: '2-digit',
        minute: '2-digit'
      }).format(date);
      target.title = date.toLocaleString(getLocale());
    }

    function configureCopyButton(root) {
      const existing = root.querySelector('[data-run-copy]');
      const button = existing.cloneNode(true);
      existing.replaceWith(button);
      const finalAnswer = root.querySelector('.run-completion-report .run-final-answer');
      const copyText = String(finalAnswer?.innerText || finalAnswer?.textContent || '').trim();
      button.hidden = false;
      button.disabled = !copyText;
      button.title = tr('copyConclusionTitle');
      button.setAttribute('aria-label', button.title);
      button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6.5" y="6.5" width="9" height="9" rx="2"/><path d="M13.5 6.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6.5a2 2 0 0 0 2 2h1.5"/></svg>';
      if (!copyText) return;
      button.addEventListener('click', async event => {
        event.stopPropagation();
        try {
          await writeClipboardText(copyText);
          button.title = tr('copyConclusionDone');
        } catch (_error) {
          button.title = tr('copyConclusionFailed');
        }
        button.setAttribute('aria-label', button.title);
      });
    }

    async function writeClipboardText(text) {
      if (navigatorRef?.clipboard?.writeText) {
        await navigatorRef.clipboard.writeText(text);
        return;
      }
      const textarea = documentRef.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      documentRef.body.append(textarea);
      textarea.select();
      const copied = documentRef.execCommand('copy');
      textarea.remove();
      if (!copied) throw new Error('clipboard_copy_failed');
    }

    return Object.freeze({ configureResultActions });
  }

  return Object.freeze({ create });
});
