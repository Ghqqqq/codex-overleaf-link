(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./runCompletionMeta'));
  else root.CodexOverleafModuleRegistry.define('RunResultActions', ['RunCompletionMeta'], factory);
})(typeof window !== 'undefined' ? window : globalThis, function (RunCompletionMeta) {
  'use strict';

  const { splitFlatCompletionReport, projectNotStartedRun, projectFinishedRun, projectCompletionConclusion, projectCompletionBody, projectCompletionMeta, summarizeCompletionMeta } = RunCompletionMeta;


  function create(deps = {}) {
    const {
      tr,
      forkRunFromNode,
      document: documentRef = globalThis.document,
      navigator: navigatorRef = globalThis.navigator
    } = deps;

    function configureResultActions(root, run) {
      const actions = root.querySelector('.run-result-actions');
      const reports = root.querySelectorAll('.run-completion-report');
      const report = reports[reports.length - 1];
      if (!actions || !report) return;
      // Share one row with the facts summary when it exists; the expandable
      // details list stays below both.
      const factsToggle = report.querySelector(':scope > .run-final-answer__facts > .run-final-answer__facts-sum');
      if (factsToggle) factsToggle.after(actions);
      else {
        // Without a facts summary, the report's own Details toggle shares the row.
        const details = report.querySelector(':scope > .run-outcome-details, :scope > .run-outcome-footer > .run-outcome-details');
        if (details) {
          let footer = details.parentElement.matches('.run-outcome-footer') ? details.parentElement : null;
          if (!footer) {
            footer = documentRef.createElement('div');
            footer.className = 'run-outcome-footer';
            details.before(footer);
            footer.append(details);
          }
          footer.append(actions);
        } else report.append(actions);
      }
      actions.hidden = false;
      configureCopyButton(root);
      configureForkButton(root, run);
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
      button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path transform="translate(.5 0)" d="M3 10h3.5c3.5 0 4.2-4 7.5-4h2m-2.5-2.5L16 6l-2.5 2.5M6.5 10c3.5 0 4.2 4 7.5 4h2m-2.5-2.5L16 14l-2.5 2.5"/></svg>';
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

    function configureCopyButton(root) {
      const existing = root.querySelector('[data-run-copy]');
      const button = existing.cloneNode(true);
      existing.replaceWith(button);
      const available = Boolean(readConclusionText(root).trim());
      button.hidden = false;
      button.disabled = !available;
      button.title = tr('copyConclusionTitle');
      button.setAttribute('aria-label', button.title);
      button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><g transform="translate(.75 .75)"><rect x="6.5" y="6.5" width="9" height="9" rx="2"/><path d="M13.5 6.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6.5a2 2 0 0 0 2 2h1.5"/></g></svg>';
      if (!available) return;
      button.addEventListener('click', async event => {
        event.stopPropagation();
        try {
          const copyText = readConclusionText(root);
          if (!copyText.trim()) return;
          await writeClipboardText(copyText);
          button.title = tr('copyConclusionDone');
        } catch (_error) {
          button.title = tr('copyConclusionFailed');
        }
        button.setAttribute('aria-label', button.title);
      });
    }

    function readConclusionText(root) {
      const answer = root.querySelector('.run-completion-report .run-final-answer');
      if (!answer) return '';
      return extractConclusionText(answer).replace(/\u200b/g, '').replace(/[ \t]+$/gm, '').trim();
    }

    function extractConclusionText(node) {
      if (node.nodeType === 3) return String(node.textContent || '').replace(/\s+/g, ' ');
      const tag = node.tagName?.toLowerCase();
      if (tag === 'br') return '\n';
      if (tag === 'pre' || tag === 'code') return node.textContent || '';
      if (node.classList?.contains('run-math')) {
        const source = node.dataset.mathRendered === 'false'
          ? node.textContent || ''
          : node.querySelector('annotation[encoding="application/x-tex"]')?.textContent || '';
        const delimiter = node.dataset.mathDisplay === 'block' ? '$$' : '$';
        return source ? `${delimiter}${source}${delimiter}` : '';
      }
      const children = Array.from(node.childNodes || []);
      if (tag === 'ul' || tag === 'ol') {
        const start = Number(node.getAttribute('start') || 1);
        return children.filter(child => child.tagName?.toLowerCase() === 'li')
          .map((child, index) => `${tag === 'ol' ? `${start + index}. ` : '- '}${extractConclusionText(child)}`)
          .join('\n');
      }
      if (tag === 'table') {
        return Array.from(node.querySelectorAll('tr'), row => Array.from(row.children,
          cell => extractConclusionText(cell)).join('\t')).join('\n');
      }
      let text = '';
      let previousBlock = false;
      for (const child of children) {
        const value = extractConclusionText(child);
        if (!value) continue;
        const block = /^(p|h[1-6]|blockquote|ul|ol|pre|table|div)$/.test(child.tagName?.toLowerCase())
          || child.dataset?.mathDisplay === 'block';
        if (text && (previousBlock || block)) {
          const newlines = (text.match(/\n*$/)?.[0].length || 0) + (value.match(/^\n*/)?.[0].length || 0);
          text += '\n'.repeat(Math.max(0, 2 - newlines));
        }
        text += value;
        previousBlock = block;
      }
      return text;
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

    return Object.freeze({ configureResultActions, projectUndoAvailability, splitFlatCompletionReport, projectNotStartedRun, projectFinishedRun, projectCompletionConclusion, projectCompletionBody, projectCompletionMeta, summarizeCompletionMeta });
  }


  function projectUndoAvailability(run, projectRunSettlement) {
    const payload = run.recoveryPayload && typeof run.recoveryPayload === 'object'
      ? run.recoveryPayload : run;
    if (!Array.isArray(payload.appliedOperations)) return projectRunSettlement(run);
    // Forward creation/asset writes alone do not provide a rollback. Filter them only for
    // display; preserve the canonical settlement and every real recovery field.
    const appliedOperations = payload.appliedOperations.filter(operation =>
      operation?.type !== 'create' && operation?.type !== 'binary-create' && operation?.type !== 'overwrite-binary');
    if (appliedOperations.length === payload.appliedOperations.length) return projectRunSettlement(run);
    return projectRunSettlement({
      ...run,
      recoveryPayload: { ...payload, appliedOperations }
    });
  }

  return Object.freeze({ create });
});
