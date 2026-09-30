(function initCodexOverleafDiagnosticsPanel() {
  'use strict';

  function create(options = {}) {
    const container = options.container;
    if (!container) {
      throw new Error('CodexOverleafDiagnosticsPanel requires a container');
    }
    const instance = {
      container,
      callbacks: options.callbacks || {},
      i18n: options.i18n || {},
      dismissInstalled: false,
      resultDismissed: false,
      cleanup: []
    };

    container.innerHTML = `
      <div class="codex-diagnostics-wrap">
        <button type="button" class="codex-diagnostics-trigger" data-diagnostics-menu title="Diagnostics" aria-label="Diagnostics" aria-expanded="false">
          <span class="codex-diagnostics-dot" data-diagnostics-health-dot data-health="unknown"></span>
        </button>
        <div class="codex-diagnostics-menu" data-diagnostics-popover hidden>
          <div class="codex-diagnostics-hint" data-i18n="diagnosticsHint">Use when Codex cannot run, write, or read files</div>
          <button type="button" class="codex-diagnostics-runall" data-diagnostics-run-all>
            <span data-i18n="diagnosticsRunAllTitle">Run all checks</span>
            <small data-i18n="diagnosticsRunAllSubtitle">Connection, write access, project read, OT mirror</small>
          </button>
          <div class="codex-diagnostics-menu-sep"></div>
          <button type="button" data-diagnostics-native-env>
            <span data-i18n="diagnosticsNativeTitle">Check Local Connection</span>
            <small data-i18n="diagnosticsNativeSubtitle">Codex, Native Host, LaTeX tools</small>
          </button>
          <button type="button" data-diagnostics-page-state>
            <span data-i18n="diagnosticsPageTitle">Check Overleaf Write Access</span>
            <small data-i18n="diagnosticsPageSubtitle">Current file, write access, track changes</small>
          </button>
          <button type="button" data-diagnostics-snapshot>
            <span data-i18n="diagnosticsSnapshotTitle">Check Project Read</span>
            <small data-i18n="diagnosticsSnapshotSubtitle">Full project, assets, read source</small>
          </button>
          <button type="button" data-diagnostics-ot>
            <span data-i18n="diagnosticsOtTitle">Check OT Mirror</span>
            <small data-i18n="diagnosticsOtSubtitle">Status, fresh files, fallback</small>
          </button>
          <button type="button" data-diagnostics-export>
            <span data-i18n="diagnosticsExportTitle">Export Diagnostics</span>
            <small data-i18n="diagnosticsExportSubtitle">Redacted audit and environment bundle</small>
          </button>
        </div>
        <section class="codex-diagnostics-result" data-diagnostics-result role="region" aria-label="Diagnostics" hidden>
          <div class="codex-diagnostics-result-head">
            <div>
              <div class="codex-diagnostics-result-title" data-diagnostics-result-title></div>
              <div class="codex-diagnostics-result-subtitle" data-diagnostics-result-subtitle></div>
            </div>
            <button type="button" data-diagnostics-result-close title="Close" aria-label="Close diagnostics result"><span class="codex-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg></span></button>
          </div>
          <div class="codex-diagnostics-result-scroll">
            <div class="codex-diagnostics-result-body" data-diagnostics-result-body></div>
            <details class="codex-diagnostics-technical" data-diagnostics-result-details>
              <summary data-i18n="technicalDetails">Technical Details</summary>
              <pre data-diagnostics-result-technical></pre>
            </details>
          </div>
        </section>
      </div>
    `;

    bindStaticActions(instance);
    installDismiss(instance);

    return {
      show: () => toggleMenu(instance, true),
      hide: () => closeMenu(instance),
      updateStatus: status => updateStatus(instance, status),
      destroy: () => destroy(instance),
      _instance: instance
    };
  }

  function bindStaticActions(instance) {
    const root = instance.container;
    root.querySelector('[data-diagnostics-menu]')?.addEventListener('click', () => toggleMenu(instance));
    root.querySelector('[data-diagnostics-run-all]')?.addEventListener('click', () => instance.callbacks.onRunAll?.());
    root.querySelector('[data-diagnostics-native-env]')?.addEventListener('click', () => instance.callbacks.onNativeEnvironment?.());
    root.querySelector('[data-diagnostics-page-state]')?.addEventListener('click', () => instance.callbacks.onPageState?.());
    root.querySelector('[data-diagnostics-snapshot]')?.addEventListener('click', () => instance.callbacks.onSnapshot?.());
    root.querySelector('[data-diagnostics-ot]')?.addEventListener('click', () => instance.callbacks.onOtDiagnostics?.());
    root.querySelector('[data-diagnostics-export]')?.addEventListener('click', () => instance.callbacks.onExport?.());
    root.querySelector('[data-diagnostics-result-close]')?.addEventListener('click', () => {
      closeResult(instance);
      root.querySelector('[data-diagnostics-menu]')?.focus();
    });
  }

  function toggleMenu(target, forceOpen) {
    const instance = target?._instance || target;
    const popover = instance?.container?.querySelector('[data-diagnostics-popover]');
    const button = instance?.container?.querySelector('[data-diagnostics-menu]');
    if (!popover || !button) {
      return;
    }
    const result = instance.container.querySelector('[data-diagnostics-result]');
    if (forceOpen === undefined && result && !result.hidden) {
      closeResult(instance);
      return;
    }
    const open = typeof forceOpen === 'boolean' ? forceOpen : popover.hidden;
    if (open) {
      closeResult(instance);
      instance.callbacks.onBeforeOpen?.();
    }
    popover.hidden = !open;
    if (open) {
      openFloating(instance, popover, 300);
    } else {
      hideFloating(popover);
    }
    button.dataset.active = open ? 'true' : 'false';
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function closeMenu(target) {
    const instance = target?._instance || target;
    const popover = instance?.container?.querySelector('[data-diagnostics-popover]');
    const button = instance?.container?.querySelector('[data-diagnostics-menu]');
    if (!popover || !button) {
      return;
    }
    hideFloating(popover);
    button.dataset.active = 'false';
    button.setAttribute('aria-expanded', 'false');
  }

  function closeResult(target) {
    const instance = target?._instance || target;
    if (instance) instance.resultDismissed = true;
    const result = instance?.container?.querySelector('[data-diagnostics-result]');
    if (result) {
      hideFloating(result);
    }
  }

  function showLoading(target, title, subtitle) {
    const instance = target?._instance || target;
    if (instance) instance.resultDismissed = false;
    showResult(instance, {
      title,
      subtitle: subtitle || t(instance, 'diagnosticsLoading'),
      status: 'running',
      summary: t(instance, 'diagnosticsLoadingSummary')
    });
  }

  function showResult(target, result = {}) {
    const instance = target?._instance || target;
    if (instance?.resultDismissed) return;
    const root = instance?.container?.querySelector('[data-diagnostics-result]');
    if (!root) {
      return;
    }

    const wasHidden = root.hidden;
    root.hidden = false;
    root.dataset.status = result.status || 'info';
    root.setAttribute('aria-label', result.title || t(instance, 'diagnosticsResult'));
    root.querySelector('[data-diagnostics-result-title]').textContent = result.title || t(instance, 'diagnosticsResult');
    root.querySelector('[data-diagnostics-result-subtitle]').textContent = result.subtitle || '';

    const body = root.querySelector('[data-diagnostics-result-body]');
    body.textContent = '';
    if (result.summary) {
      appendParagraph(body, result.summary);
    }
    // Aggregated health report: one status row per check (Run all checks).
    if (Array.isArray(result.checks) && result.checks.length) {
      renderCheckRows(body, result.checks);
    } else if (!result.summary) {
      appendParagraph(body, t(instance, 'diagnosticsNoResult'));
    }
    if (Array.isArray(result.bullets) && result.bullets.length) {
      const list = document.createElement('ul');
      for (const item of result.bullets) {
        const li = document.createElement('li');
        li.textContent = item;
        list.append(li);
      }
      body.append(list);
    }
    if (result.nextStep) {
      const next = document.createElement('p');
      next.className = 'codex-diagnostics-next-step';
      next.textContent = `${t(instance, 'nextStepPrefix')}${result.nextStep}`;
      body.append(next);
    }
    if (result.installCommand) {
      renderInstallCommand(instance, body, result.installCommand);
    }

    const details = root.querySelector('[data-diagnostics-result-details]');
    const technical = root.querySelector('[data-diagnostics-result-technical]');
    const technicalText = String(result.technical || '').trim();
    details.open = false;
    details.hidden = !technicalText;
    technical.textContent = technicalText;
    closeMenu(instance);
    openFloating(instance, root, 400);
    if (wasHidden) root.querySelector('[data-diagnostics-result-close]')?.focus({ preventScroll: true });
  }

  // Keep DOM ownership (theme, locale and callbacks), but render above clipping
  // ancestors where the browser supports the top layer. Fixed positioning is
  // the viewport-based fallback for browsers without the Popover API.
  function openFloating(instance, element, preferredWidth) {
    if (element.isConnected === false) return;
    element.hidden = false;
    if (typeof element.showPopover === 'function') {
      element.setAttribute('popover', 'manual');
      try {
        if (!element.matches(':popover-open')) element.showPopover();
      } catch (_error) {
        element.removeAttribute('popover');
      }
    }
    positionFloating(instance, element, preferredWidth);
  }

  function hideFloating(element) {
    if (!element) return;
    if (typeof element.hidePopover === 'function' && element.getAttribute('popover') === 'manual') {
      try {
        if (element.matches(':popover-open')) element.hidePopover();
      } catch (_error) {
        element.removeAttribute('popover');
      }
    }
    element.hidden = true;
  }

  function positionFloating(instance, element, preferredWidth) {
    if (!element || element.hidden) return;
    const button = instance.container.querySelector('[data-diagnostics-menu]');
    if (!button?.getBoundingClientRect || !element.getBoundingClientRect) return;
    if (button.getClientRects && !button.getClientRects().length) {
      closeMenu(instance);
      closeResult(instance);
      return;
    }
    const doc = instance.container.ownerDocument || document;
    const view = doc.defaultView || window;
    const viewport = view.visualViewport;
    const width = viewport?.width || view.innerWidth || doc.documentElement?.clientWidth;
    const height = viewport?.height || view.innerHeight || doc.documentElement?.clientHeight;
    if (!(width > 0 && height > 0)) return;
    const margin = 12;
    const gap = 8;
    const viewportLeft = viewport?.offsetLeft || 0;
    const viewportTop = viewport?.offsetTop || 0;
    const panel = instance.container.closest?.('#codex-overleaf-panel')?.getBoundingClientRect?.();
    const leftEdge = Math.max(viewportLeft, panel?.left ?? viewportLeft) + margin;
    const topEdge = Math.max(viewportTop, panel?.top ?? viewportTop) + margin;
    const rightEdge = Math.min(viewportLeft + width, panel?.right ?? viewportLeft + width) - margin;
    const bottomEdge = Math.min(viewportTop + height, panel?.bottom ?? viewportTop + height) - margin;
    if (rightEdge <= leftEdge || bottomEdge <= topEdge) {
      closeMenu(instance);
      closeResult(instance);
      return;
    }
    element.style.width = `${Math.min(preferredWidth, rightEdge - leftEdge)}px`;
    element.style.maxHeight = `${Math.min(480, bottomEdge - topEdge)}px`;
    const anchor = button.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    const below = Math.max(0, bottomEdge - anchor.bottom - gap);
    const above = Math.max(0, anchor.top - topEdge - gap);
    const desiredTop = bounds.height > below && above > below
      ? anchor.top - gap - bounds.height
      : anchor.bottom + gap;
    element.style.left = `${Math.max(leftEdge, Math.min(anchor.right - bounds.width, rightEdge - bounds.width))}px`;
    element.style.top = `${Math.max(topEdge, Math.min(desiredTop, bottomEdge - bounds.height))}px`;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
  }

  function renderInstallCommand(instance, container, command) {
    const wrap = document.createElement('div');
    wrap.className = 'codex-install-command';

    const label = document.createElement('div');
    label.className = 'codex-install-command-label';
    label.textContent = t(instance, 'runInTerminal');
    wrap.append(label);

    const code = document.createElement('code');
    code.textContent = command;
    wrap.append(code);

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.textContent = t(instance, 'copyInstallCommand');
    copyButton.addEventListener('click', async () => {
      await navigator.clipboard.writeText(command);
      copyButton.textContent = t(instance, 'copied');
      setTimeout(() => {
        copyButton.textContent = t(instance, 'copyInstallCommand');
      }, 1400);
    });
    wrap.append(copyButton);

    container.append(wrap);
  }

  function appendParagraph(container, text) {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    container.append(paragraph);
  }

  // Map a result status to a coarse health bucket used for the row glyph + the
  // overall dot. 'completed' reads as a pass; anything not-ok is attention.
  function healthBucket(status) {
    if (status === 'completed' || status === 'ok') return 'ok';
    if (status === 'warning' || status === 'warn') return 'warn';
    if (status === 'failed' || status === 'fail') return 'fail';
    return 'info';
  }

  // Render the aggregated report as one scannable row per check: a status glyph
  // (via CSS [data-status]), a plain-language title + summary, and an optional
  // actionable next step.
  function renderCheckRows(container, checks) {
    const list = document.createElement('div');
    list.className = 'codex-diagnostics-checks';
    for (const check of checks) {
      if (!check) continue;
      const row = document.createElement('details');
      row.className = 'codex-diagnostics-check';
      row.dataset.status = healthBucket(check.status);
      row.open = row.dataset.status === 'warn' || row.dataset.status === 'fail';
      const heading = document.createElement('summary');

      const glyph = document.createElement('span');
      glyph.className = 'codex-diagnostics-check-glyph';
      glyph.setAttribute('aria-hidden', 'true');

      const textWrap = document.createElement('div');
      textWrap.className = 'codex-diagnostics-check-text';
      const title = document.createElement('div');
      title.className = 'codex-diagnostics-check-title';
      title.textContent = check.title || '';
      heading.append(glyph, title);
      if (check.summary) {
        const summary = document.createElement('div');
        summary.className = 'codex-diagnostics-check-summary';
        summary.textContent = check.summary;
        textWrap.append(summary);
      }
      if (check.nextStep) {
        const next = document.createElement('div');
        next.className = 'codex-diagnostics-check-next';
        next.textContent = `→ ${check.nextStep}`;
        textWrap.append(next);
      }

      row.append(heading, textWrap);
      list.append(row);
    }
    container.append(list);
  }

  function installDismiss(instance) {
    if (instance.dismissInstalled) {
      return;
    }
    instance.dismissInstalled = true;
    const doc = instance.container.ownerDocument || document;
    const view = doc.defaultView || window;
    const listen = (target, type, handler, options) => {
      if (!target?.addEventListener) return;
      target.addEventListener(type, handler, options);
      instance.cleanup.push(() => target.removeEventListener(type, handler, options));
    };
    listen(doc, 'click', event => {
      const wrap = instance.container?.querySelector('.codex-diagnostics-wrap');
      if (!wrap || wrap.contains(event.target)) {
        return;
      }
      closeMenu(instance);
      closeResult(instance);
    }, true);
    listen(doc, 'keydown', event => {
      if (event.key !== 'Escape') return;
      const menu = instance.container.querySelector('[data-diagnostics-popover]');
      const result = instance.container.querySelector('[data-diagnostics-result]');
      if (menu && !menu.hidden) closeMenu(instance);
      else if (result && !result.hidden) closeResult(instance);
      else return;
      event.preventDefault();
      event.stopPropagation();
      instance.container.querySelector('[data-diagnostics-menu]')?.focus();
    }, true);
    let frame = null;
    const reposition = () => {
      frame = null;
      positionFloating(instance, instance.container.querySelector('[data-diagnostics-popover]'), 300);
      positionFloating(instance, instance.container.querySelector('[data-diagnostics-result]'), 400);
    };
    const schedule = () => {
      if (frame !== null) return;
      if (view.requestAnimationFrame) frame = view.requestAnimationFrame(reposition);
      else reposition();
    };
    listen(view, 'resize', schedule);
    listen(doc, 'scroll', schedule, true);
    listen(view.visualViewport, 'resize', schedule);
    listen(view.visualViewport, 'scroll', schedule);
    if (typeof view.ResizeObserver === 'function') {
      const observer = new view.ResizeObserver(schedule);
      for (const node of [
        instance.container.closest('#codex-overleaf-panel') || instance.container,
        instance.container.querySelector('[data-diagnostics-popover]'),
        instance.container.querySelector('[data-diagnostics-result]')
      ]) {
        if (node) observer.observe(node);
      }
      instance.cleanup.push(() => observer.disconnect());
    }
    instance.cleanup.push(() => {
      if (frame !== null) view.cancelAnimationFrame?.(frame);
    });
  }

  // Drive the trigger's health dot. `health` is one of ok / warn / fail /
  // unknown; the dot colors via [data-health] in CSS so the button signals the
  // overall state without being opened. Driven by the native-compatibility
  // status, and refreshed by a Run-all diagnostics pass.
  const HEALTH_STATES = ['ok', 'warn', 'fail', 'unknown'];
  function updateStatus(target, status = {}) {
    const instance = target?._instance || target;
    if (!Object.prototype.hasOwnProperty.call(status, 'health')) {
      return;
    }
    const dot = instance?.container?.querySelector('[data-diagnostics-health-dot]');
    if (!dot) {
      return;
    }
    const health = HEALTH_STATES.indexOf(status.health) !== -1 ? status.health : 'unknown';
    dot.dataset.health = health;
    // The 9px dot carries the whole health signal; give the trigger a
    // per-state tooltip so the colors are decodable without opening the menu.
    const trigger = instance?.container?.querySelector('[data-diagnostics-menu]');
    if (trigger) {
      const tooltipKey = {
        ok: 'diagnosticsDotOk',
        warn: 'diagnosticsDotWarn',
        fail: 'diagnosticsDotFail',
        unknown: 'diagnosticsDotUnknown'
      }[health] || 'diagnosticsDotUnknown';
      const tooltip = t(instance, tooltipKey);
      trigger.title = tooltip;
      trigger.setAttribute('aria-label', tooltip);
    }
  }

  function formatProjectSnapshotUserLog(project, options = {}) {
    const tx = options.tx || ((english) => english);
    const files = project?.files || [];
    if (!files.length) {
      return tx(
        'No Overleaf project files were read yet. Make sure the project has loaded, or open a .tex file in Overleaf and retry.',
        '还没有读到 Overleaf 项目文件。请确认项目已加载完成，或在 Overleaf 点开一个 .tex 文件后重试。'
      );
    }
    const textCount = files.filter(isTextSnapshotFile).length;
    const binaryCount = files.length - textCount;
    const resourceText = binaryCount ? tx(`, ${binaryCount} asset file(s)`, `，${binaryCount} 个资源文件`) : '';
    const activePath = project.activePath ? tx(`, current file: ${project.activePath}`, `，当前文件：${project.activePath}`) : '';
    const focusFiles = options.getFocusFiles?.() || [];
    const focusText = focusFiles.length ? tx(`, focus: ${focusFiles.join(', ')}`, `，优先处理：${focusFiles.join(', ')}`) : '';
    return tx(
      `Read Overleaf project: ${textCount} text file(s)${resourceText}${activePath}${focusText}.`,
      `已读取 Overleaf 项目：${textCount} 个文本文件${resourceText}${activePath}${focusText}。`
    );
  }

  function formatProjectSnapshotFileSize(file) {
    if (isTextSnapshotFile(file)) return `${String(file.content || '').length} chars`;
    if (Number.isFinite(Number(file?.size))) return `${Number(file.size)} bytes`;
    return file?.contentBase64 ? `${String(file.contentBase64).length} base64` : 'binary';
  }

  function formatProjectSnapshotWarning(warning, tx = (english => english)) {
    if (/No source files were captured/i.test(warning)) {
      return tx('No project source files were read. Make sure Overleaf has loaded, or open a .tex file and retry.', '没有读取到项目源文件。请确认 Overleaf 页面加载完成，或点开一个 .tex 文件后重试。');
    }
    if (/Full project snapshot was not captured/i.test(warning)) {
      return tx('The full Overleaf project was not read. To avoid refreshing the local workspace from an incomplete snapshot, reload Overleaf or retry later.', '没有读到完整的 Overleaf 项目。为了避免本地 workspace 用残缺快照覆盖项目，请刷新 Overleaf 或稍后重试。');
    }
    if (/empty or still loading/i.test(warning)) {
      return tx('Some file content is still loading. Wait for Overleaf to finish loading, then retry.', '读取到的文件内容还在加载中。请等 Overleaf 加载完成后重试。');
    }
    if (/suspiciously short|shorter than 80 characters/i.test(warning)) {
      return tx('Some file content is very short and may not have fully loaded. Results may be incomplete.', '部分文件内容很短，可能还没完全加载。结果可能不完整。');
    }
    if (/identical captured content/i.test(warning)) {
      return tx('Several files appear to have identical captured content, so Overleaf file switching may have failed. Reload and retry.', '多个文件内容看起来相同，Overleaf 文件切换可能没有成功。请刷新页面后重试。');
    }
    if (/were skipped/i.test(warning)) {
      return tx('Some project files were skipped, usually images, PDFs, or unreadable files.', '有些项目文件被跳过，通常是图片、PDF 或无法读取的文件。');
    }
    return warning;
  }

  function appendEditorDiagnostics(editorDiagnostics, projectDiagnostics, appendLog = () => {}) {
    if (editorDiagnostics) {
      const active = editorDiagnostics.active;
      appendLog(`Editor probe: active ${active?.tag || 'none'} ${active?.ariaLabel || active?.className || ''} len=${active?.valueLength || 0}; textareas=${editorDiagnostics.textareaCount || 0}; editables=${editorDiagnostics.editableCount || 0}; iframes=${editorDiagnostics.iframeCount || 0}.`);
      if (editorDiagnostics.documentStats) {
        const stats = editorDiagnostics.documentStats;
        appendLog(`DOM stats: elements=${stats.elementCount || 0}; textareas=${stats.textareaCount || 0}; cm=${stats.cmCount || 0}; role textbox=${stats.roleTextboxCount || 0}.`);
      }
      if (editorDiagnostics.unstableStore) {
        const store = editorDiagnostics.unstableStore;
        const readable = (store.readable || []).map(item => `${item.path}:${item.present ? item.type : 'missing'}`).join(', ');
        appendLog(`Overleaf store: ${store.present ? 'present' : 'missing'}${readable ? `; ${readable}` : ''}.`);
      }
      if (editorDiagnostics.codeMirrorView) {
        const view = editorDiagnostics.codeMirrorView;
        appendLog(`CodeMirror view: docLength=${view.docLength || 0}; dispatch=${Boolean(view.hasDispatch)}; source=${view.source || 'unknown'}.`);
      }
      if (editorDiagnostics.globals) {
        const globals = editorDiagnostics.globals;
        appendLog(`Overleaf globals: overleaf=${globals.overleaf || 'missing'}; Overleaf=${globals.Overleaf || 'missing'}; _ide=${globals._ide || 'missing'}.`);
      }
      for (const item of [...(editorDiagnostics.textareas || []), ...(editorDiagnostics.editables || [])].slice(0, 3)) {
        appendLog(`Editor candidate: ${item.tag || 'node'} ${item.ariaLabel || item.className || item.id || ''} len=${item.valueLength || 0}.`);
      }
    }
    if (projectDiagnostics) {
      const records = projectDiagnostics.docRecords || [];
      appendLog(`Project probe: doc records=${projectDiagnostics.docRecordCount || 0}; roots=${(projectDiagnostics.internalRootKeys || []).slice(0, 6).join(', ') || 'none'}.`);
      for (const record of records.slice(0, 4)) appendLog(`Doc record: ${record.path} id=${record.id} source=${record.source || 'internal'}.`);
    }
  }

  function appendProjectWarnings(project, options = {}) {
    const warnings = options.getWarnings?.(project) || { blocking: [], nonBlocking: [] };
    for (const warning of warnings.blocking) options.appendLog?.(`Snapshot blocked: ${warning}`);
    for (const warning of warnings.nonBlocking) options.appendLog?.(`Snapshot warning: ${warning}`);
  }

  function isTextSnapshotFile(file) {
    return Boolean(file && file.kind !== 'binary' && typeof file.content === 'string');
  }

  function uniqueContentSignatures(files) {
    return Array.from(new Set(files.map(file => {
      const content = String(file.content || '');
      return `${content.length}:${content.slice(0, 120)}:${content.slice(-120)}`;
    })));
  }

  function appendReviewingDiagnostics(diagnostics, options = {}) {
    const appendLog = options.appendLog || (() => {});
    const tx = options.tx || ((english) => english);
    if (!diagnostics) {
      appendLog(tx('Probe diagnostics unavailable.', '诊断探针不可用。'));
      return;
    }
    appendLog(`Probe saw ${diagnostics.controlCount || 0} controls; body Reviewing=${Boolean(diagnostics.bodyTextHasReviewing)}, text Reviewing=${Boolean(diagnostics.textContentHasReviewing)}.`);
    const controls = diagnostics.reviewLikeControls || [];
    if (!controls.length) {
      appendLog('Probe did not see review/track/suggest controls in the page DOM.');
      return;
    }
    for (const control of controls.slice(0, 4)) {
      const label = [
        control.text,
        control.ariaLabel && `aria:${control.ariaLabel}`,
        control.title && `title:${control.title}`,
        control.dataTestId && `test:${control.dataTestId}`,
        control.id && `id:${control.id}`
      ].filter(Boolean).join(' | ');
      appendLog(`Review-like ${control.tag || 'node'}: ${label || control.htmlSnippet || '(no label)'}`);
    }
  }

  function t(instance, key, params) {
    if (typeof instance?.i18n === 'function') {
      return instance.i18n(key, params);
    }
    if (typeof instance?.i18n?.tr === 'function') {
      return instance.i18n.tr(key, params);
    }
    if (typeof instance?.i18n?.t === 'function') {
      return instance.i18n.t(key, params);
    }
    return key;
  }

  function destroy(instance) {
    closeMenu(instance);
    closeResult(instance);
    for (const cleanup of instance.cleanup || []) cleanup();
    instance.cleanup = [];
    instance.container.textContent = '';
  }

  window.CodexOverleafDiagnosticsPanel = {
    appendEditorDiagnostics,
    appendProjectWarnings,
    appendReviewingDiagnostics,
    create,
    formatProjectSnapshotFileSize,
    formatProjectSnapshotUserLog,
    formatProjectSnapshotWarning,
    isTextSnapshotFile,
    updateStatus,
    toggleMenu,
    closeMenu,
    closeResult,
    showLoading,
    showResult,
    uniqueContentSignatures
  };
})();
