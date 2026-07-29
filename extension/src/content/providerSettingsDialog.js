(function initCodexOverleafProviderSettingsDialog() {
  'use strict';

  // Official OpenAI blossom mark used by the Codex VS Code extension.
  const CODEX_BLOSSOM_PATH = 'M13.798 23.976a5.7 5.7 0 0 1-2.26-.456 6.1 6.1 0 0 1-1.903-1.27 5.7 5.7 0 0 1-1.88.311 5.75 5.75 0 0 1-2.95-.79 6.2 6.2 0 0 1-2.188-2.159q-.81-1.366-.809-3.045 0-.695.19-1.51a6.4 6.4 0 0 1-1.475-2.038A5.95 5.95 0 0 1 0 10.573Q0 9.278.547 8.08q.547-1.2 1.523-2.062a5.5 5.5 0 0 1 2.307-1.223A5.7 5.7 0 0 1 5.472 2.35 6.1 6.1 0 0 1 7.565.623 5.8 5.8 0 0 1 10.206 0q1.19 0 2.26.456a6.1 6.1 0 0 1 1.903 1.27 5.7 5.7 0 0 1 1.88-.311q1.594 0 2.95.79a6 6 0 0 1 2.165 2.159q.832 1.366.832 3.045 0 .695-.19 1.51a6.3 6.3 0 0 1 1.475 2.062q.523 1.15.523 2.422a5.9 5.9 0 0 1-.547 2.493q-.547 1.2-1.546 2.086a5.4 5.4 0 0 1-2.284 1.199 5.56 5.56 0 0 1-1.118 2.445 5.9 5.9 0 0 1-2.07 1.727 5.8 5.8 0 0 1-2.64.623m-5.876-2.997q1.19 0 2.07-.504l4.472-2.589a.53.53 0 0 0 .238-.455v-2.062L8.945 18.7a.96.96 0 0 1-1.047 0l-4.496-2.613a.7.7 0 0 1-.024.168v.287q0 1.224.571 2.254a4.24 4.24 0 0 0 1.642 1.583q1.047.6 2.331.599m.238-3.908a.6.6 0 0 0 .262.072q.118 0 .238-.072l1.784-1.031-5.734-3.357q-.522-.312-.523-.935V6.545a4.3 4.3 0 0 0-1.903 1.63 4.25 4.25 0 0 0-.714 2.398q0 1.176.595 2.254.594 1.08 1.546 1.63zm5.638 5.323q1.26 0 2.284-.576a4.3 4.3 0 0 0 1.618-1.582q.595-1.008.595-2.254v-5.179a.47.47 0 0 0-.238-.431l-1.808-1.055v6.689q0 .624-.524.935l-4.496 2.613a4.3 4.3 0 0 0 2.57.84m.904-8.776v-3.26l-2.688-1.535-2.712 1.535v3.26l2.712 1.535zM7.756 5.97q0-.623.523-.935l4.496-2.613a4.3 4.3 0 0 0-2.569-.84q-1.26 0-2.284.576A4.3 4.3 0 0 0 6.304 3.74q-.57 1.008-.57 2.254v5.155q0 .287.237.455l1.785 1.055zM19.84 17.43a4.16 4.16 0 0 0 1.88-1.63 4.33 4.33 0 0 0 .713-2.397q0-1.176-.595-2.254-.594-1.08-1.546-1.63l-4.449-2.59q-.143-.096-.261-.072a.46.46 0 0 0-.238.072L13.56 7.936l5.758 3.38a.9.9 0 0 1 .38.384q.143.216.143.528zM15.059 5.25q.524-.335 1.047 0l4.52 2.662V7.48q0-1.15-.57-2.181A4.14 4.14 0 0 0 18.46 3.62q-1.023-.623-2.379-.623-1.19 0-2.07.503L9.54 6.09a.53.53 0 0 0-.238.455v2.062z';

  function create(options = {}) {
    const Profiles = options.ProviderProfiles;
    if (!Profiles) {
      throw new Error('Provider settings dialog requires provider profiles.');
    }
    const instance = {
      Profiles,
      document: options.document || document,
      tx: options.tx || ((english) => english),
      callbacks: options.callbacks || {},
      catalog: Profiles.normalizeCatalog({}),
      selectedId: 'builtin',
      draft: null,
      dirty: false,
      busy: '',
      secretAction: 'unchanged',
      verifications: {},
      pendingCatalog: null,
      root: null,
      returnFocus: null
    };
    ensureRoot(instance);
    return {
      open: catalog => open(instance, catalog),
      close: () => requestClose(instance),
      setCatalog: (catalog, selectedId) => setCatalog(instance, catalog, selectedId),
      offerCatalog: (catalog, selectedId) => offerCatalog(instance, catalog, selectedId),
      setBusy: (kind, message) => setBusy(instance, kind, message),
      setStatus: status => setStatus(instance, status),
      setVerification: verification => setVerification(instance, verification),
      setVerificationFailure: failure => setVerificationFailure(instance, failure),
      setTestProgress: progress => setTestProgress(instance, progress),
      hasUnsavedChanges: () => instance.dirty,
      isOpen: () => Boolean(instance.root && !instance.root.hidden),
      destroy: () => destroy(instance),
      _instance: instance
    };
  }

  function ensureRoot(instance) {
    if (instance.root) {
      return instance.root;
    }
    const root = instance.document.createElement('div');
    root.className = 'codex-provider-dialog-root';
    root.hidden = true;
    root.innerHTML = `
      <div class="codex-provider-dialog-backdrop" data-provider-backdrop></div>
      <section class="codex-provider-dialog" role="dialog" aria-modal="true" aria-labelledby="codex-provider-dialog-title">
        <header class="codex-provider-dialog-head">
          <div class="codex-provider-dialog-heading">
            <div class="codex-provider-dialog-titleline">
              <h2 id="codex-provider-dialog-title" data-provider-dialog-title></h2>
              <span class="codex-provider-experimental-badge" data-provider-dialog-experimental></span>
            </div>
            <p data-provider-dialog-subtitle></p>
          </div>
          <button type="button" class="codex-provider-dialog-close" data-provider-action="close" aria-label="Close">×</button>
        </header>
        <div class="codex-provider-dialog-body">
          <aside class="codex-provider-list" data-provider-list></aside>
          <main class="codex-provider-detail" data-provider-detail></main>
        </div>
        <footer class="codex-provider-dialog-foot">
          <div class="codex-provider-operation-status" data-provider-status aria-live="polite"></div>
          <div class="codex-provider-footer-actions" data-provider-footer-actions></div>
        </footer>
      </section>
    `;
    instance.document.documentElement.appendChild(root);
    instance.root = root;
    root.addEventListener('click', event => handleClick(instance, event));
    root.addEventListener('input', event => handleInput(instance, event));
    root.addEventListener('change', event => handleInput(instance, event));
    root.addEventListener('keydown', event => handleKeydown(instance, event));
    root.addEventListener('mousedown', event => event.stopPropagation());
    root.addEventListener('click', event => event.stopPropagation());
    return root;
  }

  function open(instance, catalog) {
    instance.returnFocus = instance.document.activeElement;
    instance.root.hidden = false;
    syncTheme(instance);
    setCatalog(instance, catalog || instance.catalog);
    queueMicrotask(() => {
      instance.root.querySelector('[data-provider-row][aria-current="true"]')?.focus?.()
        || instance.root.querySelector('input, button, select, textarea')?.focus?.();
    });
  }

  function requestClose(instance) {
    if (instance.dirty && !instance.document.defaultView.confirm(instance.tx(
      'Discard unsaved provider changes?',
      '放弃尚未保存的模型服务配置吗？'
    ))) {
      return false;
    }
    if (instance.busy === 'testing') {
      instance.callbacks.onCancelTest?.();
      instance.busy = '';
    }
    instance.root.hidden = true;
    instance.busy = '';
    instance.returnFocus?.focus?.();
    return true;
  }

  function setCatalog(instance, catalog, selectedId) {
    instance.catalog = instance.Profiles.normalizeCatalog(catalog || {});
    const nextId = selectedId || (
      instance.catalog.providers.some(provider => provider.id === instance.selectedId)
        ? instance.selectedId
        : instance.catalog.activeProviderId
    );
    instance.selectedId = nextId || 'builtin';
    instance.draft = null;
    instance.dirty = false;
    delete instance.root.dataset.dirty;
    instance.secretAction = 'unchanged';
    instance.verifications = {};
    instance.pendingCatalog = null;
    setStatus(instance, { tone: '', title: '' });
    render(instance);
  }

  function offerCatalog(instance, catalog, selectedId) {
    if (!instance.dirty) {
      setCatalog(instance, catalog, selectedId);
      return true;
    }
    instance.pendingCatalog = { catalog, selectedId };
    setStatus(instance, {
      tone: 'warning',
      title: instance.tx(
        'Provider settings changed in another tab. The local draft was kept.',
        '其他标签页更新了模型服务配置，当前本地草稿已保留。'
      )
    });
    renderFooter(instance);
    applyBusyState(instance);
    return false;
  }

  function render(instance) {
    const tx = instance.tx;
    instance.root.querySelector('[data-provider-dialog-title]').textContent = tx('Model API providers', '模型 API 服务');
    instance.root.querySelector('[data-provider-dialog-experimental]').textContent = tx(
      'Third-party experimental',
      '第三方实验性'
    );
    instance.root.querySelector('[data-provider-dialog-subtitle]').textContent = tx(
      "Configure experimental third-party integrations used by this project's future Codex runs. Compatibility varies by provider and gateway.",
      '配置当前项目后续 Codex 任务使用的实验性第三方集成；兼容性取决于具体模型服务与网关。'
    );
    renderProviderList(instance);
    renderDetail(instance);
    renderFooter(instance);
    applyBusyState(instance);
  }

  function renderProviderList(instance) {
    const tx = instance.tx;
    const list = instance.root.querySelector('[data-provider-list]');
    const rows = instance.catalog.providers.map(provider => {
      const selected = provider.id === instance.selectedId;
      const active = provider.id === getCurrentProjectProviderId(instance);
      const diagnosticCount = Object.values(provider.modelDiagnostics || {}).filter(item => item.status === 'tested').length;
      const status = active
        ? tx('Current project', '当前项目')
        : diagnosticCount
          ? tx(`Tested ${diagnosticCount}/${Math.max(1, provider.models.length)}`, `已测试 ${diagnosticCount}/${Math.max(1, provider.models.length)}`)
          : provider.kind === 'custom'
            ? tx('Untested', '未测试')
            : '';
      return `
        <button type="button" class="codex-provider-row" data-provider-row="${escapeAttr(provider.id)}" aria-current="${selected ? 'true' : 'false'}">
          <span class="codex-provider-row-main" title="${escapeAttr(provider.name)}">${escapeHtml(provider.name)}</span>
          ${status ? `<span class="codex-provider-row-status" data-tone="${active ? 'active' : 'muted'}">${escapeHtml(status)}</span>` : ''}
        </button>
      `;
    });
    if (instance.selectedId === '__new__') {
      rows.push(`
        <button type="button" class="codex-provider-row" data-provider-row="__new__" aria-current="true">
          <span class="codex-provider-row-main">${escapeHtml(tx('New provider', '新模型服务'))}</span>
          <span class="codex-provider-row-status" data-tone="muted">${escapeHtml(tx('Draft', '草稿'))}</span>
        </button>
      `);
    }
    rows.push(`<button type="button" class="codex-provider-add" data-provider-action="add">+ ${escapeHtml(tx('Add provider', '添加模型服务'))}</button>`);
    list.innerHTML = rows.join('');
  }

  function renderDetail(instance) {
    const detail = instance.root.querySelector('[data-provider-detail]');
    const provider = getSelectedProvider(instance);
    if (!provider || provider.kind === 'builtin') {
      renderBuiltinDetail(instance, detail);
      return;
    }
    const tx = instance.tx;
    const draft = instance.draft || provider;
    const defaultModel = (draft.models || []).find(model => model.id === draft.defaultModelId) || {};
    const additionalModels = (draft.models || [])
      .map(model => model.id)
      .filter(id => id !== draft.defaultModelId)
      .join('\n');
    const active = provider.id && provider.id === getCurrentProjectProviderId(instance);
    const acceptedHost = getEndpointHost(draft.baseUrl);
    const secretSavedAt = formatSecretSavedAt(instance, provider.secretUpdatedAt);
    const disclosureSatisfied = Boolean(
      provider.endpointDisclosureHost &&
      provider.endpointDisclosureHost === acceptedHost &&
      provider.endpointDisclosureBaseUrl === draft.baseUrl
    );
    detail.innerHTML = `
      <div class="codex-provider-detail-titleline">
        <div>
          <h3>${escapeHtml(draft.name || tx('Custom provider', '自定义模型服务'))}</h3>
          <p>${escapeHtml(active ? tx('Used by new runs in this project', '当前项目的新任务将使用此服务') : tx('Saved provider profile', '已保存的模型服务配置'))}</p>
        </div>
        ${active ? `<span class="codex-provider-active-badge">${escapeHtml(tx('Current project', '当前项目'))}</span>` : ''}
      </div>
      <div class="codex-provider-form-grid">
        <label class="codex-provider-field">
          <span>${escapeHtml(tx('Provider name', '服务名称'))}</span>
          <input type="text" data-provider-field="name" maxlength="64" value="${escapeAttr(draft.name || '')}">
        </label>
        <label class="codex-provider-field codex-provider-field--wide">
          <span>${escapeHtml(tx('Base URL', '基础 URL'))}</span>
          <input type="url" data-provider-field="baseUrl" value="${escapeAttr(draft.baseUrl || '')}" placeholder="https://provider.example/v1" spellcheck="false">
          <small>${escapeHtml(tx('HTTPS is required except for localhost.', '除 localhost 外必须使用 HTTPS。'))}</small>
        </label>
        <label class="codex-provider-field codex-provider-field--wide">
          <span>${escapeHtml(tx('API key', 'API 密钥'))}</span>
          <div class="codex-provider-secret-row">
            <input type="password" data-provider-field="apiKey" autocomplete="new-password" placeholder="${escapeAttr(provider.hasSecret ? tx('Configured; enter a new key to replace it', '已配置；输入新密钥即可替换') : tx('Optional for local no-auth endpoints', '本地无鉴权端点可留空'))}">
            ${provider.hasSecret ? `<button type="button" class="codex-provider-inline-button" data-provider-action="clear-secret">${escapeHtml(tx('Clear', '清除'))}</button>` : ''}
          </div>
          <small data-provider-secret-note>${provider.hasSecret
            ? `<strong>${escapeHtml(tx('API key saved locally.', 'API 密钥已保存到本地。'))}</strong> ${escapeHtml(secretSavedAt
              ? tx(`Last replaced ${secretSavedAt}. The plaintext is never returned to the Extension.`, `上次替换于 ${secretSavedAt}。扩展不会读回密钥明文。`)
              : tx('Stored by the Native Host. The plaintext is never returned to the Extension.', '由 Native Host 保管。扩展不会读回密钥明文。'))}`
            : escapeHtml(tx('No API key is currently stored. Local no-auth endpoints may leave this empty.', '当前未存储 API 密钥。本地无鉴权端点可以留空。'))}</small>
        </label>
        <label class="codex-provider-field codex-provider-field--wide">
          <span>${escapeHtml(tx('Default model', '默认模型'))}</span>
          <input type="text" data-provider-field="defaultModelId" value="${escapeAttr(draft.defaultModelId || '')}" placeholder="model-id" spellcheck="false">
        </label>
        <label class="codex-provider-field codex-provider-field--wide">
          <span>${escapeHtml(tx('Additional models', '其他模型'))}</span>
          <textarea data-provider-field="additionalModels" rows="3" placeholder="one-model-id-per-line" spellcheck="false">${escapeHtml(additionalModels)}</textarea>
          <small>${escapeHtml(tx('Enter one model ID per line.', '每行填写一个模型 ID。'))}</small>
        </label>
      </div>
      <details class="codex-provider-advanced">
        <summary>${escapeHtml(tx('Advanced compatibility', '高级兼容设置'))}</summary>
        <div class="codex-provider-form-grid">
          <label class="codex-provider-field">
            <span>${escapeHtml(tx('API protocol', 'API 协议'))}</span>
            <select data-provider-field="wireApiPreference">
              <option value="auto" ${draft.wireApiPreference === 'auto' ? 'selected' : ''}>${escapeHtml(tx('Auto (detect during test)', '自动（测试时检测）'))}</option>
              <option value="responses" ${draft.wireApiPreference === 'responses' ? 'selected' : ''}>Responses API</option>
              <option value="chat" ${draft.wireApiPreference === 'chat' ? 'selected' : ''}>Chat Completions</option>
              <option value="anthropic" ${draft.wireApiPreference === 'anthropic' ? 'selected' : ''}>Anthropic Messages</option>
            </select>
          </label>
          <label class="codex-provider-field">
            <span>${escapeHtml(tx('Upstream response mode', '上游响应模式'))}</span>
            <select data-provider-field="upstreamResponseMode">
              <option value="auto" ${defaultModel.upstreamResponseMode === 'auto' || !defaultModel.upstreamResponseMode ? 'selected' : ''}>${escapeHtml(tx('Auto (test streaming, then buffered)', '自动（先测流式，再测缓冲）'))}</option>
              <option value="streaming" ${defaultModel.upstreamResponseMode === 'streaming' ? 'selected' : ''}>${escapeHtml(tx('Streaming', '流式'))}</option>
              <option value="buffered" ${defaultModel.upstreamResponseMode === 'buffered' ? 'selected' : ''}>${escapeHtml(tx('Buffered', '缓冲'))}</option>
            </select>
            <small>${escapeHtml(tx('Applied to the default model. Buffered keeps Codex streaming locally while the provider returns one complete response.', '应用于默认模型。缓冲模式仍向 Codex 本地流式输出，但等待服务商返回完整响应。'))}</small>
          </label>
          <label class="codex-provider-field">
            <span>${escapeHtml(tx('Request timeout', '请求超时'))}</span>
            <select data-provider-field="requestTimeoutMs">
              ${[15000, 30000, 60000, 120000].map(value => `<option value="${value}" ${Number(draft.requestTimeoutMs) === value ? 'selected' : ''}>${value / 1000}s</option>`).join('')}
            </select>
          </label>
          <label class="codex-provider-field">
            <span>${escapeHtml(tx('API-key authentication', 'API 密钥鉴权'))}</span>
            <select data-provider-field="authMode">
              <option value="bearer" ${draft.authMode === 'bearer' || !draft.authMode ? 'selected' : ''}>Authorization: Bearer</option>
              <option value="x-api-key" ${draft.authMode === 'x-api-key' ? 'selected' : ''}>x-api-key</option>
              <option value="api-key" ${draft.authMode === 'api-key' ? 'selected' : ''}>api-key</option>
              <option value="custom" ${draft.authMode === 'custom' ? 'selected' : ''}>${escapeHtml(tx('Custom header', '自定义请求头'))}</option>
              <option value="none" ${draft.authMode === 'none' ? 'selected' : ''}>${escapeHtml(tx('No authentication', '无鉴权'))}</option>
            </select>
          </label>
          <label class="codex-provider-field">
            <span>${escapeHtml(tx('Custom API-key header', '自定义密钥请求头'))}</span>
            <input type="text" data-provider-field="apiKeyHeaderName" value="${escapeAttr(draft.apiKeyHeaderName || '')}" placeholder="X-API-Key" spellcheck="false">
          </label>
          <label class="codex-provider-field">
            <span>${escapeHtml(tx('Context window', '上下文窗口'))}</span>
            <input type="number" data-provider-field="contextWindow" min="8192" max="4000000" step="1024" value="${Number(draft.contextWindow) || 262144}">
          </label>
          <label class="codex-provider-field">
            <span>${escapeHtml(tx('Input modalities', '输入模态'))}</span>
            <select data-provider-field="inputModalities">
              <option value="text" ${!(draft.inputModalities || []).includes('image') ? 'selected' : ''}>Text</option>
              <option value="text,image" ${(draft.inputModalities || []).includes('image') ? 'selected' : ''}>Text + image</option>
            </select>
          </label>
          <label class="codex-provider-field">
            <span>${escapeHtml(tx('Reasoning control', '推理控制'))}</span>
            <select data-provider-field="reasoningAdapter">
              <option value="auto" ${draft.reasoningAdapter === 'auto' || !draft.reasoningAdapter ? 'selected' : ''}>${escapeHtml(tx('Auto-detect', '自动检测'))}</option>
              <option value="none" ${draft.reasoningAdapter === 'none' ? 'selected' : ''}>${escapeHtml(tx('Disabled', '禁用'))}</option>
              <option value="deepseek" ${draft.reasoningAdapter === 'deepseek' ? 'selected' : ''}>DeepSeek thinking + reasoning_effort</option>
              <option value="anthropic" ${draft.reasoningAdapter === 'anthropic' ? 'selected' : ''}>Anthropic extended thinking</option>
              <option value="reasoning_effort" ${draft.reasoningAdapter === 'reasoning_effort' ? 'selected' : ''}>reasoning_effort</option>
              <option value="openrouter" ${draft.reasoningAdapter === 'openrouter' ? 'selected' : ''}>OpenRouter reasoning.effort</option>
              <option value="enable_thinking" ${draft.reasoningAdapter === 'enable_thinking' ? 'selected' : ''}>enable_thinking</option>
              <option value="thinking" ${draft.reasoningAdapter === 'thinking' ? 'selected' : ''}>thinking.type</option>
              <option value="reasoning_split" ${draft.reasoningAdapter === 'reasoning_split' ? 'selected' : ''}>reasoning_split</option>
            </select>
          </label>
          <label class="codex-provider-field">
            <span>${escapeHtml(tx('Reasoning strengths', '推理强度'))}</span>
            <select data-provider-field="reasoningCapability">
              <option value="auto" ${draft.reasoningCapability === 'auto' || !draft.reasoningCapability ? 'selected' : ''}>${escapeHtml(tx('Auto-detect', '自动检测'))}</option>
              <option value="effort" ${draft.reasoningCapability === 'effort' ? 'selected' : ''}>${escapeHtml(tx('Low / Medium / High', '低 / 中 / 高'))}</option>
              <option value="toggle" ${draft.reasoningCapability === 'toggle' ? 'selected' : ''}>${escapeHtml(tx('On / Off only', '仅开启 / 关闭'))}</option>
              <option value="none" ${draft.reasoningCapability === 'none' ? 'selected' : ''}>${escapeHtml(tx('Not supported', '不支持'))}</option>
            </select>
          </label>
          <div class="codex-provider-field codex-provider-field--wide">
            <span>${escapeHtml(tx('Protocol capabilities', '协议能力'))}</span>
            <div class="codex-provider-capability-grid">
              <label class="codex-provider-capability-option">
                <input class="codex-provider-capability-input" type="checkbox" data-provider-field="supportsParallelToolCalls" ${draft.supportsParallelToolCalls ? 'checked' : ''}>
                <span class="codex-provider-capability-control" aria-hidden="true"></span>
                <span>${escapeHtml(tx('Parallel tool calls', '并行工具调用'))}</span>
              </label>
              <label class="codex-provider-capability-option">
                <input class="codex-provider-capability-input" type="checkbox" data-provider-field="supportsStreamOptions" ${draft.supportsStreamOptions ? 'checked' : ''}>
                <span class="codex-provider-capability-control" aria-hidden="true"></span>
                <span>stream_options</span>
              </label>
              <label class="codex-provider-capability-option codex-provider-capability-option--wide">
                <input class="codex-provider-capability-input" type="checkbox" data-provider-field="fullEndpoint" ${draft.fullEndpoint ? 'checked' : ''}>
                <span class="codex-provider-capability-control" aria-hidden="true"></span>
                <span>${escapeHtml(tx('Base URL is the full protocol endpoint', '基础 URL 已是完整协议端点'))}</span>
              </label>
            </div>
          </div>
          <label class="codex-provider-field codex-provider-field--wide">
            <span>${escapeHtml(tx('Static headers (JSON)', '静态请求头（JSON）'))}</span>
            <textarea data-provider-field="customHeaders" rows="2" spellcheck="false">${escapeHtml(formatJsonRecord(draft.customHeaders))}</textarea>
          </label>
          <label class="codex-provider-field codex-provider-field--wide">
            <span>${escapeHtml(tx('Query parameters (JSON)', '查询参数（JSON）'))}</span>
            <textarea data-provider-field="queryParams" rows="2" spellcheck="false">${escapeHtml(formatJsonRecord(draft.queryParams))}</textarea>
          </label>
          <label class="codex-provider-field codex-provider-field--wide">
            <span>${escapeHtml(tx('Protocol request overrides (JSON)', '协议请求覆盖项（JSON）'))}</span>
            <textarea data-provider-field="bodyOverrides" rows="2" spellcheck="false">${escapeHtml(formatJsonRecord(draft.bodyOverrides))}</textarea>
            <small>${escapeHtml(tx('Vendor-specific fields only; core model, messages, tools, and stream fields are protected.', '仅填写服务商特有字段；model、messages、tools 和 stream 等核心字段不可覆盖。'))}</small>
          </label>
          <label class="codex-provider-field">
            <span>Anthropic version</span>
            <input type="text" data-provider-field="anthropicVersion" value="${escapeAttr(draft.anthropicVersion || '2023-06-01')}" spellcheck="false">
          </label>
          <label class="codex-provider-field">
            <span>Anthropic beta</span>
            <input type="text" data-provider-field="anthropicBeta" value="${escapeAttr(draft.anthropicBeta || '')}" placeholder="optional" spellcheck="false">
          </label>
          <label class="codex-provider-field">
            <span>${escapeHtml(tx('Anthropic thinking mode', 'Anthropic 思考模式'))}</span>
            <select data-provider-field="anthropicThinkingMode">
              <option value="budget" ${draft.anthropicThinkingMode === 'budget' || !draft.anthropicThinkingMode ? 'selected' : ''}>${escapeHtml(tx('Token budget', 'Token 预算'))}</option>
              <option value="adaptive" ${draft.anthropicThinkingMode === 'adaptive' ? 'selected' : ''}>Adaptive</option>
              <option value="none" ${draft.anthropicThinkingMode === 'none' ? 'selected' : ''}>${escapeHtml(tx('Disabled', '禁用'))}</option>
            </select>
          </label>
          <label class="codex-provider-field">
            <span>${escapeHtml(tx('Maximum output tokens', '最大输出 Token'))}</span>
            <input type="number" data-provider-field="maxOutputTokens" min="256" max="65536" step="256" value="${Number(draft.maxOutputTokens) || 65536}">
          </label>
          <div class="codex-provider-field codex-provider-field--wide">
            <span>${escapeHtml(tx('Anthropic compatibility', 'Anthropic 兼容能力'))}</span>
            <div class="codex-provider-capability-grid">
              <label class="codex-provider-capability-option">
                <input class="codex-provider-capability-input" type="checkbox" data-provider-field="anthropicPromptCaching" ${draft.anthropicPromptCaching ? 'checked' : ''}>
                <span class="codex-provider-capability-control" aria-hidden="true"></span>
                <span>${escapeHtml(tx('Prompt caching markers', 'Prompt 缓存标记'))}</span>
              </label>
              <label class="codex-provider-capability-option">
                <input class="codex-provider-capability-input" type="checkbox" data-provider-field="impersonateClaudeCode" ${draft.impersonateClaudeCode ? 'checked' : ''}>
                <span class="codex-provider-capability-control" aria-hidden="true"></span>
                <span>${escapeHtml(tx('Claude Code gateway identity', 'Claude Code 网关身份'))}</span>
              </label>
            </div>
          </div>
        </div>
      </details>
      <label class="codex-provider-disclosure">
          <input type="checkbox" data-provider-disclosure ${disclosureSatisfied ? 'checked' : ''}>
          <span data-provider-disclosure-text>${escapeHtml(tx(
            `Future Codex runs in every Overleaf project tab may send selected project content to ${draft.baseUrl || 'this endpoint'}.`,
            `所有 Overleaf 项目标签页的后续 Codex 任务都可能把所选项目内容发送到 ${draft.baseUrl || '此端点'}。`
          ))}</span>
      </label>
      <div class="codex-provider-test-row">
        <div class="codex-provider-test-copy">
          <strong>${escapeHtml(tx('Connection check', '连接检查'))}</strong>
          <span>${escapeHtml(tx('Probe one model before using this provider.', '使用此服务商前，可选择一个模型进行探测。'))}</span>
        </div>
        <div class="codex-provider-test-controls">
          <label class="codex-provider-test-model">
            <span class="codex-provider-test-model-label">${escapeHtml(tx('Test model', '测试模型'))}</span>
            <span class="codex-provider-test-select-shell">
              <select data-provider-test-model aria-label="${escapeAttr(tx('Model to test', '要测试的模型'))}">
                ${(draft.models || []).map(model => `<option value="${escapeAttr(model.id)}" ${model.id === draft.defaultModelId ? 'selected' : ''}>${escapeHtml(model.label || model.id)}</option>`).join('')}
              </select>
              <svg class="codex-provider-test-chevron" viewBox="0 0 16 16" aria-hidden="true">
                <path d="m4 6 4 4 4-4"></path>
              </svg>
            </span>
          </label>
          <button type="button" class="codex-provider-test-button" data-provider-action="test">
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <circle cx="5" cy="9" r="2.25"></circle>
              <circle cx="13" cy="9" r="2.25"></circle>
              <path d="M7.25 9h3.5"></path>
            </svg>
            <span data-provider-test-action-label>${escapeHtml(tx('Test connection', '测试连接'))}</span>
          </button>
        </div>
        <span class="codex-provider-test-state" data-provider-test-state>${escapeHtml(formatVerification(instance, provider, draft.defaultModelId))}</span>
      </div>
    `;
  }

  function renderBuiltinDetail(instance, detail) {
    const tx = instance.tx;
    const active = getCurrentProjectProviderId(instance) === 'builtin';
    detail.innerHTML = `
      <div class="codex-provider-builtin">
        <span class="codex-provider-builtin-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false"><path d="${CODEX_BLOSSOM_PATH}"></path></svg>
        </span>
        <h3>${escapeHtml(tx('Built-in Codex', '内置 Codex'))}</h3>
        <p>${escapeHtml(tx(
          'Uses the authentication, model catalog, and provider configuration managed by the local Codex CLI.',
          '使用本地 Codex CLI 管理的身份验证、模型目录和服务配置。'
        ))}</p>
        ${active
          ? `<span class="codex-provider-active-badge">${escapeHtml(tx('Current project', '当前项目'))}</span>`
          : `<button type="button" class="codex-provider-primary-button" data-provider-action="activate-builtin">${escapeHtml(tx('Use for this project', '用于当前项目'))}</button>`}
      </div>
    `;
  }

  function getCurrentProjectProviderId(instance) {
    const providerId = instance.callbacks.getCurrentProjectProviderId?.();
    return typeof providerId === 'string' && providerId.trim()
      ? providerId.trim()
      : 'builtin';
  }

  function renderFooter(instance) {
    const actions = instance.root.querySelector('[data-provider-footer-actions]');
    const provider = getSelectedProvider(instance);
    const tx = instance.tx;
    if (!provider || provider.kind === 'builtin') {
      actions.innerHTML = `<button type="button" class="codex-provider-secondary-button" data-provider-action="close">${escapeHtml(tx('Close', '关闭'))}</button>`;
      return;
    }
    const active = provider.id && provider.id === getCurrentProjectProviderId(instance);
    const isNew = !provider.id;
    const destinationChanged = active && getCurrentBaseUrl(instance) !== provider.endpointDisclosureBaseUrl;
    const actionState = getFooterActionState({
      isNew,
      active,
      dirty: instance.dirty,
      destinationChanged,
      canSave: canSaveCurrentDraft(instance),
      canActivate: canActivateCurrentProvider(instance)
    });
    const saveDisabled = actionState.saveEnabled ? '' : ' disabled aria-disabled="true"';
    const useDisabled = actionState.useEnabled ? '' : ' disabled aria-disabled="true"';
    actions.innerHTML = `
      ${provider.id ? `<button type="button" class="codex-provider-danger-button" data-provider-action="delete">${escapeHtml(tx('Delete', '删除'))}</button>` : ''}
      ${instance.pendingCatalog ? `<button type="button" class="codex-provider-secondary-button" data-provider-action="reload-external">${escapeHtml(tx('Reload latest', '加载最新配置'))}</button>` : ''}
      <span class="codex-provider-footer-spacer"></span>
      <button type="button" class="codex-provider-secondary-button" data-provider-action="close">${escapeHtml(tx('Cancel', '取消'))}</button>
      ${actionState.showSave ? `<button type="button" class="codex-provider-secondary-button" data-provider-action="save"${saveDisabled}>${escapeHtml(tx('Save', '保存'))}</button>` : ''}
      ${actionState.showSaveAndUse ? `<button type="button" class="codex-provider-primary-button" data-provider-action="save-use"${saveDisabled}>${escapeHtml(tx('Save and use for this project', '保存并用于当前项目'))}</button>` : ''}
      ${actionState.showUse ? `<button type="button" class="codex-provider-primary-button" data-provider-action="use"${useDisabled}>${escapeHtml(tx('Use for this project', '用于当前项目'))}</button>` : ''}
    `;
  }

  function getFooterActionState(options = {}) {
    const isNew = options.isNew === true;
    const active = options.active === true;
    const dirty = options.dirty === true;
    return {
      showSave: isNew || dirty,
      showSaveAndUse: (isNew || dirty) && (!active || options.destinationChanged === true),
      showUse: !isNew && !active && !dirty,
      saveEnabled: options.canSave === true,
      useEnabled: options.canActivate === true
    };
  }

  function handleClick(instance, event) {
    const action = event.target.closest('[data-provider-action]')?.dataset.providerAction;
    const providerRow = event.target.closest('[data-provider-row]');
    if (providerRow) {
      selectProvider(instance, providerRow.dataset.providerRow);
      return;
    }
    if (!action) {
      return;
    }
    event.preventDefault();
    if (action === 'close') {
      requestClose(instance);
      return;
    }
    if (action === 'add') {
      selectProvider(instance, '__new__');
      return;
    }
    if (action === 'reload-external') {
      if (!instance.pendingCatalog) return;
      if (instance.dirty && !instance.document.defaultView.confirm(instance.tx(
        'Discard this draft and load the latest provider settings?',
        '放弃当前草稿并加载最新模型服务配置吗？'
      ))) {
        return;
      }
      const pending = instance.pendingCatalog;
      setCatalog(instance, pending.catalog, pending.selectedId);
      return;
    }
    if (action === 'clear-secret') {
      const provider = getSelectedProvider(instance);
      if (provider?.id && provider.hasSecret) {
        const warning = instance.dirty
          ? instance.tx(
              'Remove the stored API key now? Unsaved form changes will be discarded when the saved profile reloads.',
              '立即删除已存储的 API 密钥吗？重新加载已保存配置时，未保存的表单改动会被放弃。'
            )
          : instance.tx('Remove the stored API key now?', '立即删除已存储的 API 密钥吗？');
        if (instance.document.defaultView.confirm(warning)) {
          instance.callbacks.onClearSecret?.({
            profileId: provider.id,
            expectedRevision: provider.revision
          });
        }
        return;
      }
      instance.secretAction = 'clear';
      const input = instance.root.querySelector('[data-provider-field="apiKey"]');
      if (input) input.value = '';
      const note = instance.root.querySelector('[data-provider-secret-note]');
      if (note) note.textContent = instance.tx('The saved key will be removed on Save.', '保存后将删除已存储的密钥。');
      markDirty(instance);
      return;
    }
    if (action === 'activate-builtin') {
      instance.callbacks.onActivateBuiltin?.();
      return;
    }
    if (action === 'delete') {
      const context = readContext(instance);
      if (instance.document.defaultView.confirm(instance.tx(
        `Delete ${context.draft.name}?`,
        `删除 ${context.draft.name} 吗？`
      ))) {
        instance.callbacks.onDelete?.(context);
      }
      return;
    }
    if (action === 'test') {
      const modelId = getSelectedTestModelId(instance);
      invalidateVerification(instance, false, modelId);
      instance.callbacks.onTest?.(readContext(instance));
      return;
    }
    if (action === 'cancel-test') {
      instance.callbacks.onCancelTest?.();
      setBusy(instance, '', '');
      setStatus(instance, { tone: 'warning', title: instance.tx('Connection test cancelled.', '连接测试已取消。') });
      return;
    }
    if (action === 'use') {
      if (!canActivateCurrentProvider(instance)) {
        setStatus(instance, {
          tone: 'failed',
          title: instance.tx('Save this provider before using it.', '使用前请先保存此模型服务。')
        });
        return;
      }
      const context = readContext(instance);
      if (!instance.root.querySelector('[data-provider-disclosure]')?.checked) {
        setStatus(instance, {
          tone: 'failed',
          title: instance.tx('Confirm the endpoint disclosure before activating this provider.', '启用此服务前，请先确认端点披露说明。')
        });
        return;
      }
      instance.callbacks.onActivate?.(context);
      return;
    }
    if (action === 'save' || action === 'save-use') {
      const context = readContext(instance);
      if (action === 'save-use' && !instance.root.querySelector('[data-provider-disclosure]')?.checked) {
        setStatus(instance, {
          tone: 'failed',
          title: instance.tx('Confirm the endpoint disclosure before activating this provider.', '启用此服务前，请先确认端点披露说明。')
        });
        return;
      }
      instance.callbacks.onSave?.(context, { activate: action === 'save-use' });
    }
  }

  function handleInput(instance, event) {
    if (event.target.matches('[data-provider-test-model]')) {
      refreshTestState(instance);
      return;
    }
    if (event.target.matches('[data-provider-field]')) {
      const field = event.target.dataset.providerField;
      if (event.target.dataset.providerField === 'apiKey') {
        instance.secretAction = event.target.value ? 'replace' : (getSelectedProvider(instance)?.hasSecret ? 'unchanged' : 'clear');
      }
      if (field === 'baseUrl') {
        const disclosure = instance.root.querySelector('[data-provider-disclosure]');
        if (disclosure) disclosure.checked = false;
        updateDisclosureText(instance);
      }
      markDirty(instance, { invalidateVerification: field !== 'name' });
      if (field === 'baseUrl') {
        renderFooter(instance);
        applyBusyState(instance);
      }
    }
  }

  function handleKeydown(instance, event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose(instance);
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = Array.from(instance.root.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'))
      .filter(element => !element.closest('[hidden]'));
    if (!focusable.length) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && instance.document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && instance.document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function selectProvider(instance, id) {
    if (id === instance.selectedId) {
      return;
    }
    if (instance.dirty && !instance.document.defaultView.confirm(instance.tx(
      'Discard unsaved provider changes?',
      '放弃尚未保存的模型服务配置吗？'
    ))) {
      return;
    }
    instance.selectedId = id;
    instance.draft = id === '__new__'
      ? instance.Profiles.buildEmptyDraft()
      : null;
    instance.dirty = false;
    delete instance.root.dataset.dirty;
    instance.secretAction = 'unchanged';
    instance.verifications = {};
    instance.pendingCatalog = null;
    setStatus(instance, { tone: '', title: '' });
    render(instance);
  }

  function readContext(instance) {
    const provider = getSelectedProvider(instance) || instance.Profiles.buildEmptyDraft();
    const get = name => instance.root.querySelector(`[data-provider-field="${name}"]`);
    const defaultModelId = String(get('defaultModelId')?.value || '').trim();
    const modelIds = [defaultModelId, ...String(get('additionalModels')?.value || '').split(/\r?\n/)]
      .map(value => value.trim())
      .filter((value, index, values) => value && values.indexOf(value) === index);
    const existingModels = new Map((provider.models || []).map(model => [model.id, model]));
    const upstreamResponseMode = get('upstreamResponseMode')?.value || 'auto';
    const draft = {
      name: String(get('name')?.value || '').trim(),
      baseUrl: String(get('baseUrl')?.value || '').trim(),
      wireApiPreference: get('wireApiPreference')?.value || 'auto',
      models: modelIds.map(id => {
        const existing = existingModels.get(id) || {};
        return {
          ...existing,
          id,
          label: existing.label || id,
          reasoningEfforts: Array.isArray(existing.reasoningEfforts) ? existing.reasoningEfforts : [],
          upstreamResponseMode: id === defaultModelId
            ? upstreamResponseMode
            : existing.upstreamResponseMode || 'auto',
          resolvedUpstreamResponseMode: existing.resolvedUpstreamResponseMode || '',
          contextWindow: Number(get('contextWindow')?.value || 262144),
          supportsParallelToolCalls: Boolean(get('supportsParallelToolCalls')?.checked),
          inputModalities: String(get('inputModalities')?.value || 'text').split(',')
        };
      }),
      defaultModelId,
      requestTimeoutMs: Number(get('requestTimeoutMs')?.value || 30000),
      reasoningAdapter: get('reasoningAdapter')?.value || 'auto',
      reasoningCapability: get('reasoningCapability')?.value || 'auto',
      authMode: get('authMode')?.value || 'bearer',
      apiKeyHeaderName: String(get('apiKeyHeaderName')?.value || '').trim(),
      fullEndpoint: Boolean(get('fullEndpoint')?.checked),
      customHeaders: String(get('customHeaders')?.value || '').trim(),
      queryParams: String(get('queryParams')?.value || '').trim(),
      bodyOverrides: String(get('bodyOverrides')?.value || '').trim(),
      contextWindow: Number(get('contextWindow')?.value || 262144),
      supportsParallelToolCalls: Boolean(get('supportsParallelToolCalls')?.checked),
      supportsStreamOptions: Boolean(get('supportsStreamOptions')?.checked),
      inputModalities: String(get('inputModalities')?.value || 'text').split(',')
      ,anthropicVersion: String(get('anthropicVersion')?.value || '2023-06-01').trim()
      ,anthropicBeta: String(get('anthropicBeta')?.value || '').trim()
      ,anthropicThinkingMode: get('anthropicThinkingMode')?.value || 'budget'
      ,anthropicPromptCaching: Boolean(get('anthropicPromptCaching')?.checked)
      ,impersonateClaudeCode: Boolean(get('impersonateClaudeCode')?.checked)
      ,maxOutputTokens: Number(get('maxOutputTokens')?.value || 65536)
    };
    const apiKey = String(get('apiKey')?.value || '');
    const secretMutation = instance.secretAction === 'replace' && apiKey
      ? { kind: 'replace', value: apiKey }
      : instance.secretAction === 'clear'
        ? { kind: 'clear' }
        : { kind: 'unchanged' };
    return {
      profileId: provider.id || '',
      expectedRevision: provider.revision || 0,
      draft,
      secretMutation,
      verification: instance.verifications[getSelectedTestModelId(instance)] || null,
      verifications: Object.values(instance.verifications).filter(item => item?.status === 'tested'),
      testModelId: getSelectedTestModelId(instance) || defaultModelId,
      disclosureHost: getEndpointHost(draft.baseUrl),
      disclosureBaseUrl: draft.baseUrl
    };
  }

  function getSelectedProvider(instance) {
    if (instance.selectedId === '__new__') {
      return instance.draft || instance.Profiles.buildEmptyDraft();
    }
    return instance.catalog.providers.find(provider => provider.id === instance.selectedId)
      || instance.catalog.providers.find(provider => provider.id === 'builtin');
  }

  function markDirty(instance, options = {}) {
    const footerNeedsRefresh = instance.dirty !== true;
    instance.dirty = true;
    instance.root.dataset.dirty = 'true';
    if (options.invalidateVerification !== false) {
      instance.verifications = {};
      invalidateVerification(instance, true);
    }
    if (footerNeedsRefresh) {
      // Saved providers initially render Use (inactive) or no primary action
      // (active). The first edit changes that action contract to Save, so the
      // footer must be rebuilt without re-rendering and losing form values.
      renderFooter(instance);
      applyBusyState(instance);
    }
  }

  function setBusy(instance, kind, message) {
    instance.busy = kind || '';
    if (message) {
      setStatus(instance, { tone: kind === 'failed' ? 'failed' : 'progress', title: message });
    } else if (!kind) {
      setStatus(instance, { tone: '', title: '' });
    }
    syncTestAction(instance);
    applyBusyState(instance);
  }

  function applyBusyState(instance) {
    const busy = Boolean(instance.busy && instance.busy !== 'failed');
    const canSave = canSaveCurrentDraft(instance);
    const canActivate = canActivateCurrentProvider(instance);
    instance.root.dataset.busy = instance.busy || '';
    for (const element of instance.root.querySelectorAll('input, select, textarea, button')) {
      if (element.matches('[data-provider-action="close"]')) {
        element.disabled = false;
      } else if (element.matches('[data-provider-action="cancel-test"]')) {
        element.disabled = false;
      } else if (element.matches('[data-provider-action="save"], [data-provider-action="save-use"]')) {
        element.disabled = busy || !canSave;
      } else if (element.matches('[data-provider-action="use"]')) {
        element.disabled = busy || !canActivate;
      } else {
        element.disabled = busy;
      }
    }
  }

  function setStatus(instance, status = {}) {
    const element = instance.root.querySelector('[data-provider-status]');
    element.dataset.tone = status.tone || '';
    element.textContent = [status.title, status.detail].filter(Boolean).join(' ');
  }

  function setVerification(instance, verification = {}) {
    const modelId = String(verification.modelId || verification.testedModelId || getSelectedTestModelId(instance)).trim();
    instance.verifications[modelId] = { ...verification, modelId, status: 'tested' };
    setStatus(instance, {
      tone: 'success',
      title: instance.tx('Connection verified.', '连接验证成功。'),
      detail: [
        verification.resolvedWireApi,
        verification.resolvedUpstreamResponseMode
          ? `${verification.resolvedUpstreamResponseMode} upstream`
          : '',
        `${verification.durationMs || 0}ms`
      ].filter(Boolean).join(' · ')
    });
    refreshTestState(instance);
    applyBusyState(instance);
  }

  function setVerificationFailure(instance, failure = {}) {
    const modelId = String(failure.modelId || getSelectedTestModelId(instance)).trim();
    instance.verifications[modelId] = {
      modelId,
      status: 'failed',
      errorCode: failure.errorCode || ''
    };
    refreshTestState(instance);
  }

  function setTestProgress(instance, progress = {}) {
    const detail = progress.detail || progress;
    const modelId = detail.modelId || getSelectedTestModelId(instance);
    setStatus(instance, {
      tone: 'progress',
      title: instance.tx(
        `Testing ${modelId}: ${detail.wireApi} · ${detail.upstreamResponseMode} (${detail.attempt}/${detail.totalAttempts})`,
        `正在测试 ${modelId}：${detail.wireApi} · ${detail.upstreamResponseMode}（${detail.attempt}/${detail.totalAttempts}）`
      )
    });
  }

  function invalidateVerification(instance, changed, modelId = '') {
    if (modelId) {
      delete instance.verifications[modelId];
    }
    const state = instance.root.querySelector('[data-provider-test-state]');
    if (state) {
      const provider = getSelectedProvider(instance);
      const selectedModelId = modelId || getSelectedTestModelId(instance) || provider?.defaultModelId;
      state.textContent = changed
        ? instance.tx('Compatibility has not been tested for these settings', '当前配置尚未测试兼容性')
        : formatVerification(instance, provider, selectedModelId);
      state.dataset.tone = changed ? 'warning' : '';
    }
    applyBusyState(instance);
  }

  function canSaveCurrentDraft(instance) {
    const provider = getSelectedProvider(instance);
    return Boolean(provider && provider.kind === 'custom');
  }

  function canActivateCurrentProvider(instance) {
    const provider = getSelectedProvider(instance);
    return Boolean(
      provider?.id &&
      !instance.dirty
    );
  }

  function formatVerification(instance, provider, modelId) {
    const transient = instance.verifications[modelId];
    if (transient?.status === 'failed') {
      return instance.tx('Failed in this dialog', '本次测试失败');
    }
    if (transient?.status === 'tested') {
      return instance.tx('Tested for this draft', '当前草稿已测试');
    }
    const diagnostic = provider?.modelDiagnostics?.[modelId];
    if (diagnostic?.status === 'tested') {
      const mode = diagnostic.upstreamResponseMode;
      return mode
        ? `${instance.tx('Tested', '已测试')} · ${diagnostic.wireApi || ''} · ${mode}`
        : instance.tx('Tested', '已测试');
    }
    return instance.tx('Untested; testing is optional', '尚未测试；测试为可选功能');
  }

  function refreshTestState(instance) {
    const state = instance.root.querySelector('[data-provider-test-state]');
    if (!state) return;
    const provider = getSelectedProvider(instance);
    const modelId = getSelectedTestModelId(instance) || provider?.defaultModelId;
    state.textContent = formatVerification(instance, provider, modelId);
    const status = instance.verifications[modelId]?.status || provider?.modelDiagnostics?.[modelId]?.status || '';
    state.dataset.tone = status === 'failed' ? 'failed' : status === 'tested' ? 'success' : '';
  }

  function getSelectedTestModelId(instance) {
    return String(instance.root.querySelector('[data-provider-test-model]')?.value || '').trim();
  }

  function getCurrentBaseUrl(instance) {
    return String(instance.root.querySelector('[data-provider-field="baseUrl"]')?.value || '').trim();
  }

  function updateDisclosureText(instance) {
    const text = instance.root.querySelector('[data-provider-disclosure-text]');
    if (!text) return;
    const baseUrl = getCurrentBaseUrl(instance) || instance.tx('this endpoint', '此端点');
    text.textContent = instance.tx(
      `Future Codex runs in every Overleaf project tab may send selected project content to ${baseUrl}.`,
      `所有 Overleaf 项目标签页的后续 Codex 任务都可能把所选项目内容发送到 ${baseUrl}。`
    );
  }

  function syncTestAction(instance) {
    const button = instance.root.querySelector('[data-provider-action="test"], [data-provider-action="cancel-test"]');
    if (!button) return;
    const testing = instance.busy === 'testing';
    button.dataset.providerAction = testing ? 'cancel-test' : 'test';
    const actionLabel = testing
      ? instance.tx('Cancel test', '取消测试')
      : instance.tx('Test connection', '测试连接');
    const labelEl = button.querySelector('[data-provider-test-action-label]');
    if (labelEl) labelEl.textContent = actionLabel;
    else button.textContent = actionLabel;
    button.setAttribute('aria-label', actionLabel);
  }

  function formatSecretSavedAt(instance, value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return '';
    }
    return new Date(timestamp).toLocaleString(instance.tx('en-US', 'zh-CN'), {
      dateStyle: 'medium',
      timeStyle: 'short'
    });
  }

  function getEndpointHost(baseUrl) {
    try {
      return new URL(baseUrl).hostname;
    } catch (_error) {
      return '';
    }
  }

  function syncTheme(instance) {
    const panel = instance.document.querySelector('#codex-overleaf-panel');
    if (!panel) {
      return;
    }
    const style = instance.document.defaultView.getComputedStyle(panel);
    instance.root.style.setProperty('--provider-panel-bg', style.backgroundColor || '#151716');
    instance.root.style.setProperty('--provider-panel-color', style.color || '#eceeea');
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatJsonRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) {
      return '';
    }
    return JSON.stringify(value, null, 2);
  }

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll('`', '&#96;');
  }

  function destroy(instance) {
    instance.root?.remove?.();
    instance.root = null;
  }

  window.CodexOverleafProviderSettingsDialog = { create, getFooterActionState };
})();
