(function initCodexOverleafComposerPanel() {
  'use strict';

  function create(options = {}) {
    const container = options.container;
    if (!container) {
      throw new Error('CodexOverleafComposerPanel requires a container');
    }
    const instance = {
      container,
      callbacks: options.callbacks || {},
      i18n: options.i18n || {},
      attachmentController: options.attachmentController || null,
      listeners: []
    };

    container.innerHTML = `
      <form class="codex-composer" data-composer-form>
        <div class="codex-attachment-strip codex-attachment-preview-list" data-attachment-strip hidden></div>
        <div class="codex-composer-skill-context" data-composer-skill-context hidden>
          <span class="codex-composer-skill-icon" aria-hidden="true">◇</span>
          <span data-composer-skill-label></span>
          <button type="button" data-composer-skill-clear title="Clear skill" aria-label="Clear skill">×</button>
        </div>
        <textarea data-task rows="3" placeholder="Ask Codex anything. Type @ to add context"></textarea>
        <div class="codex-context-summary" data-context-summary hidden></div>
        <div class="codex-mode-row">
          <span class="codex-mode-label" data-i18n="mode">Mode</span>
          <div class="codex-mode-switch" role="group" aria-label="Write mode">
            <button type="button" data-mode-choice="ask" aria-pressed="false" title="Read and analyze only. Do not write to Overleaf.">Ask</button>
            <button type="button" data-mode-choice="confirm" aria-pressed="false" title="Show a change plan first, then write after approval.">Suggest</button>
            <button type="button" data-mode-choice="auto" aria-pressed="false" title="Write directly after authorization. Deletes still require confirmation.">Auto</button>
          </div>
          <select data-mode aria-label="Mode" hidden>
            <option value="ask">Ask</option>
            <option value="confirm">Suggest</option>
            <option value="auto">Auto</option>
          </select>
        </div>
        <div class="codex-composer-toolbar">
          <button type="button" data-add-context title="Add @ context" aria-label="Add @ context" aria-expanded="false">＋</button>
          <label class="codex-review-toggle" title="When enabled, Codex checks or switches Overleaf Reviewing/Track Changes before writing. Deletes still require confirmation.">
            <input type="checkbox" data-require-reviewing>
            <span class="codex-review-label" data-i18n="requireReviewing">Track</span>
          </label>
          <label class="codex-recompile-toggle" title="After Codex writes, click Overleaf Recompile and record the compile result for this task. Ask mode will not trigger it.">
            <input type="checkbox" data-auto-recompile>
            <span class="codex-recompile-label" data-i18n="autoCompile">Compile</span>
          </label>
          <div class="codex-model-config" data-model-config>
            <button type="button" class="codex-model-config-button" data-model-config-toggle aria-haspopup="menu" aria-expanded="false">
              <span class="codex-model-speed-indicator" data-speed-indicator hidden aria-hidden="true">
                <svg viewBox="0 0 16 16" focusable="false">
                  <path d="M8.9 1.8 3.8 8.8h3.3l-.5 5.4 5.5-7.5H8.8z"></path>
                </svg>
              </span>
              <span data-model-display>5.4</span>
              <span data-reasoning-display>Medium</span>
            </button>
            <div class="codex-model-config-popover" data-model-config-popover role="menu" hidden>
              <div class="codex-model-config-section" data-reasoning-choice-list></div>
              <div class="codex-model-config-divider"></div>
              <div class="codex-model-config-section" data-model-choice-list></div>
              <div class="codex-model-config-divider"></div>
              <div class="codex-model-config-section" data-speed-choice-list></div>
              <div class="codex-model-config-inputs" hidden>
                <select data-model aria-label="Model">
                  <option value="gpt-5.5">GPT-5.5</option>
                  <option value="gpt-5.4">GPT-5.4</option>
                  <option value="gpt-5.4-mini">GPT-5.4 Mini</option>
                  <option value="gpt-5.3-codex">GPT-5.3 Codex</option>
                  <option value="gpt-5.3-codex-spark">GPT-5.3 Codex Spark</option>
                  <option value="gpt-5.2">GPT-5.2</option>
                </select>
                <select data-reasoning aria-label="Reasoning">
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="xhigh">XHigh</option>
                </select>
                <select data-speed aria-label="Speed">
                  <option value="standard">Std</option>
                  <option value="fast">Fast</option>
                </select>
              </div>
            </div>
          </div>
          <button type="submit" data-run title="Send" aria-label="Send">↑</button>
        </div>
        <div class="codex-slash-menu" data-slash-menu hidden>
          <button type="button" data-slash-command="install-skill" data-slash-command-kind="installer">
            <span data-i18n="slashInstallSkillTitle">Install skill</span>
            <small data-i18n="slashInstallSkillSubtitle">Add a Codex Overleaf skill under this plugin.</small>
          </button>
        </div>
        <div class="codex-context-tray" data-context-tray hidden>
          <div class="codex-context-head">
            <span data-i18n="contextTitle">@ Context</span>
            <span class="codex-context-actions">
              <span class="codex-context-sync-status" data-context-sync-status data-state="idle" role="status" aria-live="polite">
                <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                  <circle class="codex-context-sync-ring" cx="10" cy="10" r="6.5"></circle>
                  <path class="codex-context-sync-check" d="M6.1 10.2 8.7 12.8 14.2 7.3"></path>
                  <path class="codex-context-sync-alert" d="M10 6.2v5.1M10 14h.01"></path>
                </svg>
                <span class="codex-context-sync-copy" data-context-sync-copy></span>
              </span>
              <button type="button" class="codex-attach-button" data-attach-file title="Attach files (PDF, images)" aria-label="Attach files (PDF, images)">⌲</button>
              <input type="file" data-attach-input multiple hidden>
              <button type="button" data-context-refresh title="Refresh file list" aria-label="Refresh file list">↻</button>
            </span>
          </div>
          <div class="codex-context-selection" data-context-selection></div>
          <div class="codex-context-status" data-context-status>Type @ to add context: @file, @compile-log, @current-section.</div>
          <div class="codex-context-files" data-context-file-list></div>
        </div>
      </form>
    `;

    bindEvents(instance);

    return {
      setRunning: running => setRunning(instance, running),
      setModels: models => setModels(instance, models),
      setMode: mode => setMode(instance, mode),
      focus: () => focus(instance),
      destroy: () => destroy(instance),
      _instance: instance
    };
  }

  function bindEvents(instance) {
    const form = instance.container.querySelector('[data-composer-form]');
    const task = instance.container.querySelector('[data-task]');
    bind(instance, form, 'submit', event => {
      event.preventDefault();
      instance.callbacks.onSubmit?.();
    });
    bind(instance, task, 'paste', event => instance.callbacks.onPaste?.(event));
    bind(instance, form, 'dragover', event => instance.callbacks.onDragOver?.(event));
    bind(instance, form, 'dragleave', event => instance.callbacks.onDragLeave?.(event));
    bind(instance, form, 'drop', event => instance.callbacks.onDrop?.(event));
    bind(instance, instance.container.querySelector('[data-run]'), 'click', event => {
      event.preventDefault();
      if (instance.callbacks.isRunning?.()) {
        instance.callbacks.onCancel?.();
        return;
      }
      form?.requestSubmit?.();
    });
    bind(instance, task, 'keydown', event => instance.callbacks.onTaskKeydown?.(event));
    bind(instance, task, 'input', event => instance.callbacks.onTaskInput?.(event));
    bind(instance, instance.container.querySelector('[data-slash-menu]'), 'click', event => instance.callbacks.onSlashMenuClick?.(event));
    bind(instance, instance.container.querySelector('[data-composer-skill-clear]'), 'click', () => instance.callbacks.onClearSkillInvocation?.());
    bind(instance, instance.container.querySelector('[data-add-context]'), 'click', () => instance.callbacks.onAddContext?.());
    bind(instance, instance.container.querySelector('[data-attach-file]'), 'click', () => instance.callbacks.onAttachClick?.());
    bind(instance, instance.container.querySelector('[data-attach-input]'), 'change', event => instance.callbacks.onAttachInput?.(event));
    bind(instance, instance.container.querySelector('[data-context-refresh]'), 'click', () => instance.callbacks.onContextRefresh?.());
    bind(instance, instance.container.querySelector('[data-model-config-toggle]'), 'click', event => {
      event.preventDefault();
      instance.callbacks.onModelConfigToggle?.(event);
    });
    bind(instance, instance.container.querySelector('[data-model-config-popover]'), 'click', event => instance.callbacks.onModelConfigChoiceClick?.(event));
    for (const button of instance.container.querySelectorAll('[data-mode-choice]')) {
      bind(instance, button, 'click', () => instance.callbacks.onModeChoice?.(button.dataset.modeChoice));
    }
    for (const selector of ['[data-model]', '[data-reasoning]', '[data-speed]', '[data-mode]', '[data-task]', '[data-require-reviewing]', '[data-auto-recompile]']) {
      const element = instance.container.querySelector(selector);
      bind(instance, element, 'change', event => instance.callbacks.onInputChange?.(event));
      bind(instance, element, 'input', event => instance.callbacks.onInputChange?.(event));
    }
  }

  function bind(instance, target, type, listener) {
    if (!target?.addEventListener) {
      return;
    }
    target.addEventListener(type, listener);
    instance.listeners.push({ target, type, listener });
  }

  function setRunning(target, running) {
    const instance = target?._instance || target;
    const runButton = instance?.container?.querySelector('[data-run]');
    if (!runButton) {
      return;
    }
    runButton.disabled = false;
    runButton.title = running ? t(instance, 'cancelRun') : t(instance, 'send');
    runButton.setAttribute('aria-label', running ? t(instance, 'cancelRun') : t(instance, 'send'));
  }

  function setModels(target, models = []) {
    const instance = target?._instance || target;
    const modelSelect = instance?.container?.querySelector('[data-model]');
    if (!modelSelect || !Array.isArray(models)) {
      return;
    }
    modelSelect.textContent = '';
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model.id || model.value || '';
      option.textContent = model.label || model.id || model.value || '';
      modelSelect.append(option);
    }
  }

  function setMode(target, mode) {
    const instance = target?._instance || target;
    const select = instance?.container?.querySelector('[data-mode]');
    if (select) {
      select.value = mode;
    }
  }

  function setState(target, state = {}) {
    const instance = target?._instance || target;
    if (Object.prototype.hasOwnProperty.call(state, 'running')) {
      setRunning(instance, state.running);
    }
    if (state.mode) {
      setMode(instance, state.mode);
    }
    if (Object.prototype.hasOwnProperty.call(state, 'compileEnabled')) {
      const checkbox = instance?.container?.querySelector('[data-auto-recompile]');
      if (checkbox) {
        checkbox.checked = state.compileEnabled !== false;
      }
    }
    if (Object.prototype.hasOwnProperty.call(state, 'trackEnabled')) {
      const checkbox = instance?.container?.querySelector('[data-require-reviewing]');
      if (checkbox) {
        checkbox.checked = state.trackEnabled === true;
      }
    }
  }

  function focus(target) {
    const instance = target?._instance || target;
    instance?.container?.querySelector('[data-task]')?.focus?.();
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
    for (const { target, type, listener } of instance.listeners.splice(0)) {
      target.removeEventListener?.(type, listener);
    }
    instance.container.textContent = '';
  }

  window.CodexOverleafComposerPanel = {
    create,
    setState,
    setModels
  };
})();
