(function initCodexOverleafProviderSettingsDialog() {
  'use strict';

  // Official OpenAI blossom mark used by the Codex VS Code extension.
  const CODEX_BLOSSOM_PATH = 'M13.798 23.976a5.7 5.7 0 0 1-2.26-.456 6.1 6.1 0 0 1-1.903-1.27 5.7 5.7 0 0 1-1.88.311 5.75 5.75 0 0 1-2.95-.79 6.2 6.2 0 0 1-2.188-2.159q-.81-1.366-.809-3.045 0-.695.19-1.51a6.4 6.4 0 0 1-1.475-2.038A5.95 5.95 0 0 1 0 10.573Q0 9.278.547 8.08q.547-1.2 1.523-2.062a5.5 5.5 0 0 1 2.307-1.223A5.7 5.7 0 0 1 5.472 2.35 6.1 6.1 0 0 1 7.565.623 5.8 5.8 0 0 1 10.206 0q1.19 0 2.26.456a6.1 6.1 0 0 1 1.903 1.27 5.7 5.7 0 0 1 1.88-.311q1.594 0 2.95.79a6 6 0 0 1 2.165 2.159q.832 1.366.832 3.045 0 .695-.19 1.51a6.3 6.3 0 0 1 1.475 2.062q.523 1.15.523 2.422a5.9 5.9 0 0 1-.547 2.493q-.547 1.2-1.546 2.086a5.4 5.4 0 0 1-2.284 1.199 5.56 5.56 0 0 1-1.118 2.445 5.9 5.9 0 0 1-2.07 1.727 5.8 5.8 0 0 1-2.64.623m-5.876-2.997q1.19 0 2.07-.504l4.472-2.589a.53.53 0 0 0 .238-.455v-2.062L8.945 18.7a.96.96 0 0 1-1.047 0l-4.496-2.613a.7.7 0 0 1-.024.168v.287q0 1.224.571 2.254a4.24 4.24 0 0 0 1.642 1.583q1.047.6 2.331.599m.238-3.908a.6.6 0 0 0 .262.072q.118 0 .238-.072l1.784-1.031-5.734-3.357q-.522-.312-.523-.935V6.545a4.3 4.3 0 0 0-1.903 1.63 4.25 4.25 0 0 0-.714 2.398q0 1.176.595 2.254.594 1.08 1.546 1.63zm5.638 5.323q1.26 0 2.284-.576a4.3 4.3 0 0 0 1.618-1.582q.595-1.008.595-2.254v-5.179a.47.47 0 0 0-.238-.431l-1.808-1.055v6.689q0 .624-.524.935l-4.496 2.613a4.3 4.3 0 0 0 2.57.84m.904-8.776v-3.26l-2.688-1.535-2.712 1.535v3.26l2.712 1.535zM7.756 5.97q0-.623.523-.935l4.496-2.613a4.3 4.3 0 0 0-2.569-.84q-1.26 0-2.284.576A4.3 4.3 0 0 0 6.304 3.74q-.57 1.008-.57 2.254v5.155q0 .287.237.455l1.785 1.055zM19.84 17.43a4.16 4.16 0 0 0 1.88-1.63 4.33 4.33 0 0 0 .713-2.397q0-1.176-.595-2.254-.594-1.08-1.546-1.63l-4.449-2.59q-.143-.096-.261-.072a.46.46 0 0 0-.238.072L13.56 7.936l5.758 3.38a.9.9 0 0 1 .38.384q.143.216.143.528zM15.059 5.25q.524-.335 1.047 0l4.52 2.662V7.48q0-1.15-.57-2.181A4.14 4.14 0 0 0 18.46 3.62q-1.023-.623-2.379-.623-1.19 0-2.07.503L9.54 6.09a.53.53 0 0 0-.238.455v2.062z';

  // Anthropic mark: https://github.com/simple-icons/simple-icons/blob/develop/icons/anthropic.svg
  // Upstream SVG blob: c917480d32596242d674985ee622d9e7dd51f81a
  const ANTHROPIC_LOGO_PATH = 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z';

  /*!
 * Provider SVG marks adapted from LobeHub Icons.
 * kimi: https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/kimi.svg (blob 1915850ee50ea636cc34b37aa11ba7f1ae0a26a2)
 * glm: https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/zhipu.svg (blob f7b12528e1ac82ef8b8b58825164bc88fa8b9e4b)
 * deepseek: https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/deepseek.svg (blob dc224e43a4d68070ca6eed494476c8ddd900bf80)
 *
 * MIT License
 * 
 * Copyright (c) 2023 LobeHub
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
  const PROVIDER_VENDOR_ICON_PATHS = Object.freeze({
  "kimi": "M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z",
  "glm": "M11.991 23.503a.24.24 0 00-.244.248.24.24 0 00.244.249.24.24 0 00.245-.249.24.24 0 00-.22-.247l-.025-.001zM9.671 5.365a1.697 1.697 0 011.099 2.132l-.071.172-.016.04-.018.054c-.07.16-.104.32-.104.498-.035.71.47 1.279 1.186 1.314h.366c1.309.053 2.338 1.173 2.286 2.523-.052 1.332-1.152 2.38-2.478 2.327h-.174c-.715.018-1.274.64-1.239 1.368 0 .124.018.23.053.337.209.373.54.658.96.8.75.23 1.517-.125 1.9-.782l.018-.035c.402-.64 1.17-.96 1.92-.711.854.284 1.378 1.226 1.099 2.167a1.661 1.661 0 01-2.077 1.102 1.711 1.711 0 01-.907-.711l-.017-.035c-.2-.323-.463-.58-.851-.711l-.056-.018a1.646 1.646 0 00-1.954.746 1.66 1.66 0 01-1.065.764 1.677 1.677 0 01-1.989-1.279c-.209-.906.332-1.83 1.257-2.043a1.51 1.51 0 01.296-.035h.018c.68-.071 1.151-.622 1.116-1.333a1.307 1.307 0 00-.227-.693 2.515 2.515 0 01-.366-1.403 2.39 2.39 0 01.366-1.208c.14-.195.21-.444.227-.693.018-.71-.506-1.261-1.186-1.332l-.07-.018a1.43 1.43 0 01-.299-.07l-.05-.019a1.7 1.7 0 01-1.047-2.114 1.68 1.68 0 012.094-1.101zm-5.575 10.11c.26-.264.639-.367.994-.27.355.096.633.379.728.74.095.362-.007.748-.267 1.013-.402.41-1.053.41-1.455 0a1.062 1.062 0 010-1.482zm14.845-.294c.359-.09.738.024.992.297.254.274.344.665.237 1.025-.107.36-.396.634-.756.718-.551.128-1.1-.22-1.23-.781a1.05 1.05 0 01.757-1.26zm-.064-4.39c.314.32.49.753.49 1.206 0 .452-.176.886-.49 1.206-.315.32-.74.5-1.185.5-.444 0-.87-.18-1.184-.5a1.727 1.727 0 010-2.412 1.654 1.654 0 012.369 0zm-11.243.163c.364.484.447 1.128.218 1.691a1.665 1.665 0 01-2.188.923c-.855-.36-1.26-1.358-.907-2.228a1.68 1.68 0 011.33-1.038c.593-.08 1.183.169 1.547.652zm11.545-4.221c.368 0 .708.2.892.524.184.324.184.724 0 1.048a1.026 1.026 0 01-.892.524c-.568 0-1.03-.47-1.03-1.048 0-.579.462-1.048 1.03-1.048zm-14.358 0c.368 0 .707.2.891.524.184.324.184.724 0 1.048a1.026 1.026 0 01-.891.524c-.569 0-1.03-.47-1.03-1.048 0-.579.461-1.048 1.03-1.048zm10.031-1.475c.925 0 1.675.764 1.675 1.706s-.75 1.705-1.675 1.705-1.674-.763-1.674-1.705c0-.942.75-1.706 1.674-1.706zm-2.626-.684c.362-.082.653-.356.761-.718a1.062 1.062 0 00-.238-1.028 1.017 1.017 0 00-.996-.294c-.547.14-.881.7-.752 1.257.13.558.675.907 1.225.783zm0 16.876c.359-.087.644-.36.75-.72a1.062 1.062 0 00-.237-1.019 1.018 1.018 0 00-.985-.301 1.037 1.037 0 00-.762.717c-.108.361-.017.754.239 1.028.245.263.606.377.953.305l.043-.01zM17.19 3.5a.631.631 0 00.628-.64c0-.355-.279-.64-.628-.64a.631.631 0 00-.628.64c0 .355.28.64.628.64zm-10.38 0a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64a.631.631 0 00-.628.64c0 .355.279.64.628.64zm-5.182 7.852a.631.631 0 00-.628.64c0 .354.28.639.628.639a.63.63 0 00.627-.606l.001-.034a.62.62 0 00-.628-.64zm5.182 9.13a.631.631 0 00-.628.64c0 .355.279.64.628.64a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64zm10.38.018a.631.631 0 00-.628.64c0 .355.28.64.628.64a.631.631 0 00.628-.64c0-.355-.279-.64-.628-.64zm5.182-9.148a.631.631 0 00-.628.64c0 .354.279.639.628.639a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64zm-.384-4.992a.24.24 0 00.244-.249.24.24 0 00-.244-.249.24.24 0 00-.244.249c0 .142.122.249.244.249zM11.991.497a.24.24 0 00.245-.248A.24.24 0 0011.99 0a.24.24 0 00-.244.249c0 .133.108.236.223.247l.021.001zM2.011 6.36a.24.24 0 00.245-.249.24.24 0 00-.244-.249.24.24 0 00-.244.249.24.24 0 00.244.249zm0 11.263a.24.24 0 00-.243.248.24.24 0 00.244.249.24.24 0 00.244-.249.252.252 0 00-.244-.248zm19.995-.018a.24.24 0 00-.245.248.24.24 0 00.245.25.24.24 0 00.244-.25.252.252 0 00-.244-.248z",
  "deepseek": "M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"
});

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
      returnFocus: null,
      providerFilter: '',
      modelFilter: '',
      templatePicker: false,
      previousProviderId: 'builtin',
      modelEditor: null,
      verificationStale: false,
      embedded: false,
      embeddedContainer: null,
      confirmation: null
    };
    ensureRoot(instance);
    return {
      open: (catalog, presentation) => open(instance, catalog, presentation),
      close: () => requestClose(instance),
      setCatalog: (catalog, selectedId) => setCatalog(instance, catalog, selectedId),
      offerCatalog: (catalog, selectedId) => offerCatalog(instance, catalog, selectedId),
      setBusy: (kind, message) => setBusy(instance, kind, message),
      setStatus: status => setStatus(instance, status),
      setVerification: verification => setVerification(instance, verification),
      setVerificationFailure: failure => setVerificationFailure(instance, failure),
      setTestProgress: progress => setTestProgress(instance, progress),
      hasUnsavedChanges: () => instance.dirty || Boolean(instance.modelEditor || instance.confirmation),
      isOpen: () => Boolean(instance.root && !instance.root.hidden),
      destroy: () => destroy(instance),
      _instance: instance
    };
  }

  function ensureRoot(instance) {
    if (instance.root) {
      return instance.root;
    }
    const root = instance.document.createElement('dialog');
    root.className = 'codex-provider-dialog-root codex-provider-v2';
    root.setAttribute('aria-labelledby', 'codex-provider-dialog-title');
    root.hidden = true;
    root.innerHTML = `
      <div class="codex-provider-dialog-backdrop" data-provider-backdrop></div>
      <section class="codex-provider-dialog">
        <header class="codex-provider-dialog-head">
          <div class="codex-provider-dialog-heading">
            <div class="codex-provider-dialog-titleline">
              <h2 id="codex-provider-dialog-title" data-provider-dialog-title></h2>
              <span class="codex-provider-experimental-badge" data-provider-dialog-experimental></span>
            </div>
            <p data-provider-dialog-subtitle></p>
          </div>
          <button type="button" class="codex-provider-inline-button" data-provider-action="reload" hidden></button>
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
    const modelDialog = instance.document.createElement('dialog');
    modelDialog.className = 'codex-provider-model-editor';
    modelDialog.setAttribute('data-provider-model-editor', '');
    modelDialog.setAttribute('aria-labelledby', 'codex-provider-model-title');
    modelDialog.addEventListener('cancel', event => {
      event.preventDefault(); event.stopPropagation(); closeModelEditor(instance);
    });
    root.appendChild(modelDialog);
    const confirmation = instance.document.createElement('dialog');
    confirmation.className = 'codex-provider-confirmation';
    confirmation.setAttribute('data-provider-confirmation', '');
    confirmation.setAttribute('aria-labelledby', 'codex-provider-confirm-title');
    confirmation.setAttribute('aria-describedby', 'codex-provider-confirm-message');
    confirmation.addEventListener('cancel', event => {
      event.preventDefault(); event.stopPropagation(); finishProviderConfirmation(instance, false);
    });
    root.appendChild(confirmation);
    instance.document.documentElement.appendChild(root);
    instance.root = root;
    root.addEventListener('click', event => handleClick(instance, event));
    root.addEventListener('input', event => handleInput(instance, event));
    root.addEventListener('change', event => handleInput(instance, event));
    root.addEventListener('keydown', event => handleKeydown(instance, event));
    root.addEventListener('cancel', event => { event.preventDefault(); requestClose(instance); });
    root.addEventListener('mousedown', event => event.stopPropagation());
    root.addEventListener('click', event => event.stopPropagation());
    return root;
  }

  function open(instance, catalog, presentation = {}) {
    const host = presentation.container || null;
    const parent = host || instance.document.documentElement;
    if (instance.root.parentElement !== parent) {
      instance.root.close?.();
      parent.appendChild(instance.root);
    }
    instance.embedded = Boolean(host);
    instance.embeddedContainer = host;
    instance.root.dataset.embedded = String(instance.embedded);
    instance.root.setAttribute('role', host ? 'region' : 'dialog');
    instance.returnFocus = instance.document.activeElement;
    instance.root.hidden = false;
    syncTheme(instance);
    if (!presentation.preserveDraft) setCatalog(instance, catalog || instance.catalog);
    if (!instance.root.open) {
      if (host) instance.root.show?.();
      else instance.root.showModal?.();
    }
    if (presentation.preserveDraft) return;
    queueMicrotask(() => {
      if (!instance.root || instance.root.hidden || instance.root.closest('[hidden]')) return;
      const target = instance.root.querySelector('[data-provider-row][aria-current="true"]')
        || instance.root.querySelector('input, button, select, textarea');
      target?.focus?.();
    });
  }

  async function requestClose(instance) {
    if (instance.confirmation) { finishProviderConfirmation(instance, false); return false; }
    if (instance.modelEditor) { closeModelEditor(instance); return false; }
    if (instance.dirty && !await confirmProviderAction(instance, instance.tx(
      'Discard unsaved provider changes?',
      '放弃尚未保存的模型服务配置吗？'
    ))) {
      return false;
    }
    if (instance.busy === 'testing') {
      instance.callbacks.onCancelTest?.();
      instance.busy = '';
    }
    const secretInput = instance.root.querySelector('[data-provider-field="apiKey"]');
    if (secretInput) secretInput.value = '';
    instance.secretAction = 'unchanged';
    instance.root.close?.();
    instance.root.hidden = true;
    instance.busy = '';
    instance.returnFocus?.focus?.();
    return true;
  }

  function setCatalog(instance, catalog, selectedId) {
    finishProviderConfirmation(instance, false, false);
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
    instance.verificationStale = false;
    instance.templatePicker = false;
    instance.modelFilter = '';
    closeModelEditor(instance, false);
    instance.pendingCatalog = null;
    setStatus(instance, { tone: '', title: '' });
    render(instance);
  }

  function offerCatalog(instance, catalog, selectedId) {
    if (!instance.dirty && !instance.modelEditor && !instance.confirmation) {
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
    const reload = instance.root.querySelector('[data-provider-action="reload"]');
    if (reload) {
      reload.hidden = !instance.embedded;
      reload.textContent = tx('Refresh', '刷新');
    }
    instance.root.querySelector('[data-provider-dialog-title]').textContent = tx('Models & providers', '模型与服务');
    instance.root.querySelector('[data-provider-dialog-experimental]').textContent = tx(
      'Third-party experimental',
      '第三方实验性'
    );
    instance.root.querySelector('[data-provider-dialog-subtitle]').textContent = tx(
      'Connect a provider, configure its models, and choose it for this project.',
      '连接模型服务，管理模型，并选择当前项目使用的连接。'
    );
    if (instance.callbacks.hasCurrentProject?.() === false) instance.root.querySelector('[data-provider-dialog-subtitle]').textContent = tx(
      'Manage shared model API profiles. Open a project to choose which provider its future turns use.',
      '管理共享模型 API 配置。进入项目后，再选择该项目后续任务使用的服务。');
    renderProviderList(instance);
    renderDetail(instance);
    renderFooter(instance);
    applyBusyState(instance);
  }

  function renderProviderList(instance) {
    const tx = instance.tx, list = instance.root.querySelector('[data-provider-list]');
    list.innerHTML = '<label class="codex-provider-search"><span class="codex-provider-sr-only">'
      + escapeHtml(tx('Search providers', '搜索服务')) + '</span><input type="search" data-provider-search value="'
      + escapeAttr(instance.providerFilter) + '" placeholder="' + escapeAttr(tx('Search providers', '搜索服务')) + '"></label>'
      + '<div class="codex-provider-nav-items">' + instance.catalog.providers.map(provider => {
        const active = provider.id === getCurrentProjectProviderId(instance);
        const subtitle = active ? tx('Current project', '当前项目') : provider.kind === 'builtin'
          ? tx('Local authentication', '本地身份验证')
          : tx(provider.models.length + ' models', provider.models.length + ' 个模型');
        const searchText = (provider.name + ' ' + (provider.baseUrl || '')).toLowerCase();
        return '<button type="button" class="codex-provider-row" data-provider-row="' + escapeAttr(provider.id)
          + '" data-provider-search-text="' + escapeAttr(searchText)
          + '" aria-current="' + String(provider.id === instance.selectedId) + '"'
          + (searchText.includes(instance.providerFilter.toLowerCase()) ? '' : ' hidden') + '>'
          + '<span class="codex-provider-nav-mark" aria-hidden="true">'
          + (provider.kind === 'builtin' ? renderProviderTemplateIcon({ id: 'openai-compatible' }) : escapeHtml(provider.name.slice(0, 1).toUpperCase())) + '</span>'
          + '<span class="codex-provider-nav-copy"><span class="codex-provider-row-main" title="' + escapeAttr(provider.name) + '">' + escapeHtml(provider.name)
          + '</span><span class="codex-provider-row-status" data-tone="' + (active ? 'active' : 'muted') + '">'
          + escapeHtml(subtitle) + '</span></span></button>';
      }).join('') + '</div><button type="button" class="codex-provider-add" data-provider-action="add">+ '
      + escapeHtml(tx('Add provider', '添加模型服务')) + '</button>';
  }

  function renderDetail(instance) {
    const detail = instance.root.querySelector('[data-provider-detail]');
    if (instance.templatePicker) { renderTemplatePicker(instance, detail); return; }
    const provider = getSelectedProvider(instance);
    if (!provider || provider.kind === 'builtin') {
      renderBuiltinDetail(instance, detail);
      return;
    }
    const tx = instance.tx;
    const draft = instance.draft || provider;
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
          <small data-provider-connection-hint hidden></small>
        </label>
        <label class="codex-provider-field codex-provider-field--wide">
          <span>${escapeHtml(tx('API key', 'API 密钥'))}</span>
          <div class="codex-provider-secret-row">
            <input type="password" data-provider-field="apiKey" autocomplete="new-password" placeholder="${escapeAttr(provider.hasSecret ? tx('Configured; enter a new key to replace it', '已配置；输入新密钥即可替换') : tx('Optional for local no-auth endpoints', '本地无鉴权端点可留空'))}">
            <button type="button" class="codex-provider-inline-button" data-provider-action="toggle-secret">${escapeHtml(tx('Show', '显示'))}</button>
            ${provider.hasSecret ? `<button type="button" class="codex-provider-inline-button" data-provider-action="clear-secret">${escapeHtml(tx('Clear', '清除'))}</button>` : ''}
          </div>
          <small data-provider-secret-note>${provider.hasSecret
            ? `<strong>${escapeHtml(tx('API key saved locally.', 'API 密钥已保存到本地。'))}</strong> ${escapeHtml(secretSavedAt
              ? tx(`Last replaced ${secretSavedAt}. The plaintext is never returned to the Extension.`, `上次替换于 ${secretSavedAt}。扩展不会读回密钥明文。`)
              : tx('Stored by the Native Host. The plaintext is never returned to the Extension.', '由 Native Host 保管。扩展不会读回密钥明文。'))}`
            : escapeHtml(tx('No API key is currently stored. Local no-auth endpoints may leave this empty.', '当前未存储 API 密钥。本地无鉴权端点可以留空。'))}</small>
        </label>
      </div>
      <section class="codex-provider-model-section" data-provider-model-section></section>
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
            <span>${escapeHtml(tx('Default context for new models', '新模型的默认上下文'))}</span>
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
            `Projects using this shared provider may send task context to ${draft.baseUrl || 'this endpoint'}. Each project chooses its own provider.`,
            `使用此共享服务配置的项目可能把任务上下文发送到 ${draft.baseUrl || '此端点'}。各项目独立选择使用的服务。`
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
    const protocol = detail.querySelector('[data-provider-field="wireApiPreference"]')?.closest('label');
    const connection = detail.querySelector('.codex-provider-form-grid');
    if (protocol && connection) { protocol.classList.add('codex-provider-field--wide'); connection.prepend(protocol); }
    const name = detail.querySelector('[data-provider-field="name"]')?.closest('label');
    const heading = detail.querySelector('.codex-provider-detail-titleline h3');
    if (name && heading) { name.classList.add('codex-provider-name-field'); heading.replaceWith(name); }
    updatePresetConnectionHint(instance);
    renderModelList(instance);
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
        ${instance.callbacks.hasCurrentProject?.() === false ? '' : active
          ? `<span class="codex-provider-active-badge">${escapeHtml(tx('Current project', '当前项目'))}</span>`
          : `<button type="button" class="codex-provider-primary-button" data-provider-action="activate-builtin">${escapeHtml(tx('Use for this project', '用于当前项目'))}</button>`}
      </div>
    `;
  }

  function getCurrentProjectProviderId(instance) {
    if (instance.callbacks.hasCurrentProject?.() === false) return '';
    const providerId = instance.callbacks.getCurrentProjectProviderId?.();
    return typeof providerId === 'string' && providerId.trim()
      ? providerId.trim()
      : 'builtin';
  }

  function renderFooter(instance) {
    const actions = instance.root.querySelector('[data-provider-footer-actions]');
    const provider = getSelectedProvider(instance);
    const tx = instance.tx;
    if (instance.templatePicker || !provider || provider.kind === 'builtin') {
      actions.innerHTML = instance.embedded ? '' : `<button type="button" class="codex-provider-secondary-button" data-provider-action="close">${escapeHtml(tx('Close', '关闭'))}</button>`;
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
      hasProject: instance.callbacks.hasCurrentProject?.() !== false,
      canActivate: canActivateCurrentProvider(instance)
    });
    const saveDisabled = actionState.saveEnabled ? '' : ' disabled aria-disabled="true"';
    const useDisabled = actionState.useEnabled ? '' : ' disabled aria-disabled="true"';
    actions.innerHTML = `
      ${provider.id ? `<button type="button" class="codex-provider-danger-button" data-provider-action="delete">${escapeHtml(tx('Delete', '删除'))}</button>` : ''}
      ${instance.pendingCatalog ? `<button type="button" class="codex-provider-secondary-button" data-provider-action="reload-external">${escapeHtml(tx('Reload latest', '加载最新配置'))}</button>` : ''}
      <span class="codex-provider-footer-spacer"></span>
      ${!instance.embedded || instance.dirty ? `<button type="button" class="codex-provider-secondary-button" data-provider-action="close">${escapeHtml(instance.embedded ? tx('Discard changes', '放弃更改') : tx('Cancel', '取消'))}</button>` : ''}
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
      showSaveAndUse: options.hasProject !== false && (isNew || dirty) && (!active || options.destinationChanged === true),
      showUse: options.hasProject !== false && !isNew && !active && !dirty,
      saveEnabled: options.canSave === true,
      useEnabled: options.canActivate === true
    };
  }

  async function handleClick(instance, event) {
    const answer = event.target.closest('[data-provider-confirm-answer]');
    if (answer) {
      event.preventDefault();
      finishProviderConfirmation(instance, answer.dataset.providerConfirmAnswer === 'confirm');
      return;
    }
    if (instance.confirmation) return;
    const template = event.target.closest('[data-provider-template]');
    if (template && (!instance.busy || instance.busy === 'failed')) {
      instance.draft = instance.Profiles.buildPresetDraft(template.dataset.providerTemplate);
      instance.draft.name = providerTemplateTitle(instance, template.dataset.providerTemplate);
      instance.templatePicker = false;
      instance.dirty = true;
      instance.root.dataset.dirty = 'true';
      instance.secretAction = 'unchanged';
      instance.verificationStale = true;
      render(instance);
      instance.root.querySelector('[data-provider-field="apiKey"]')?.focus();
      return;
    }
    const modelAction = event.target.closest('[data-provider-model-action]');
    if (modelAction) {
      if (!instance.busy || instance.busy === 'failed') handleModelAction(instance, modelAction.dataset.providerModelAction, modelAction.dataset.modelId || '');
      return;
    }
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
      if (instance.embedded) {
        const host = instance.embeddedContainer;
        const catalog = instance.pendingCatalog?.catalog || instance.catalog;
        if (await requestClose(instance) && host?.isConnected) open(instance, catalog, { container: host });
      } else requestClose(instance);
      return;
    }
    if (action === 'reload') {
      if (!instance.busy || instance.busy === 'failed') instance.callbacks.onReload?.();
      return;
    }
    if (action === 'add') {
      if (instance.selectedId === '__new__') {
        if (instance.dirty && !await confirmProviderAction(instance, instance.tx('Discard unsaved provider changes?', '放弃尚未保存的模型服务配置吗？'))) return;
        instance.draft = instance.Profiles.buildEmptyDraft();
        instance.dirty = false;
        delete instance.root.dataset.dirty;
        instance.templatePicker = true;
        render(instance);
      } else selectProvider(instance, '__new__');
      return;
    }
    if (action === 'templates-back') {
      selectProvider(instance, instance.previousProviderId || 'builtin');
      return;
    }
    if (action === 'toggle-secret') {
      const input = instance.root.querySelector('[data-provider-field="apiKey"]');
      if (input) input.type = input.type === 'password' ? 'text' : 'password';
      event.target.closest('button').textContent = instance.tx(input?.type === 'text' ? 'Hide' : 'Show', input?.type === 'text' ? '隐藏' : '显示');
      return;
    }
    if (action === 'reload-external') {
      if (!instance.pendingCatalog) return;
      if (instance.dirty && !await confirmProviderAction(instance, instance.tx(
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
        if (await confirmProviderAction(instance, warning, 'secret')) {
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
      if (await confirmProviderAction(instance, instance.tx(
        `Delete ${context.draft.name}?`,
        `删除 ${context.draft.name} 吗？`
      ), 'provider')) {
        instance.callbacks.onDelete?.(context);
      }
      return;
    }
    if (action === 'test') {
      if (!validateConnectionForm(instance)) return;
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
      if (!validateConnectionForm(instance)) return;
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
    if (instance.modelEditor && event.target.closest('[data-provider-model-editor]')) {
      updateModelReasoningSummary(instance);
      return;
    }
    if (event.target.matches('[data-provider-search]')) {
      instance.providerFilter = event.target.value;
      for (const row of instance.root.querySelectorAll('[data-provider-search-text]'))
        row.hidden = !row.dataset.providerSearchText.includes(instance.providerFilter.toLowerCase());
      return;
    }
    if (event.target.matches('[data-provider-model-search]')) {
      instance.modelFilter = event.target.value;
      filterModelRows(instance);
      return;
    }
    if (event.target.matches('[data-provider-test-model]')) {
      refreshTestState(instance);
      return;
    }
    if (event.target.matches('[data-provider-field]')) {
      const field = event.target.dataset.providerField;
      if (event.target.dataset.providerField === 'apiKey') {
        instance.secretAction = event.target.value ? 'replace' : (getSelectedProvider(instance)?.hasSecret ? 'unchanged' : 'clear');
      }
      const destinationChanged = field === 'baseUrl'
        || (field === 'wireApiPreference' && syncPresetProtocol(instance, event.target.value));
      if (destinationChanged) {
        const disclosure = instance.root.querySelector('[data-provider-disclosure]');
        if (disclosure) disclosure.checked = false;
        updateDisclosureText(instance);
      }
      markDirty(instance, { invalidateVerification: field !== 'name' });
      if (field === 'wireApiPreference') updatePresetConnectionHint(instance);
      if (destinationChanged) {
        renderFooter(instance);
        applyBusyState(instance);
      }
    }
  }

  function handleKeydown(instance, event) {
    if (instance.confirmation) {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        finishProviderConfirmation(instance, false);
      }
      return;
    }
    if (instance.modelEditor) {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeModelEditor(instance);
      } else if (event.key === 'Enter' && !event.isComposing
        && event.target.matches('input:not([type="checkbox"])')) {
        event.preventDefault(); commitModelEditor(instance);
      }
      return;
    }
    // The outer settings dialog owns focus traversal and Escape when embedded.
    if (instance.embedded) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose(instance);
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = Array.from(instance.root.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'))
      .filter(element => !element.closest('[hidden]') && (!element.getClientRects || element.getClientRects().length));
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

  async function selectProvider(instance, id) {
    if (id === instance.selectedId) {
      return;
    }
    if (instance.dirty && !await confirmProviderAction(instance, instance.tx(
      'Discard unsaved provider changes?',
      '放弃尚未保存的模型服务配置吗？'
    ))) {
      return;
    }
    if (id === '__new__') instance.previousProviderId = instance.selectedId;
    instance.templatePicker = id === '__new__';
    instance.modelFilter = '';
    instance.verificationStale = false;
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
    const modelDraft = instance.draft || provider;
    const defaultModelId = modelDraft.defaultModelId || '';
    const draft = {
      name: String(get('name')?.value || '').trim(),
      baseUrl: String(get('baseUrl')?.value || '').trim(),
      wireApiPreference: get('wireApiPreference')?.value || 'auto',
      models: (modelDraft.models || []).map(model => ({
        ...model, reasoningEfforts: [...(model.reasoningEfforts || [])],
        inputModalities: [...(model.inputModalities || ['text'])]
      })),
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
      instance.verificationStale = true;
      invalidateVerification(instance, true);
      refreshModelStatuses(instance);
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
    refreshModelStatuses(instance);
    applyBusyState(instance);
  }

  function applyBusyState(instance) {
    const busy = Boolean(instance.busy && instance.busy !== 'failed');
    const canSave = canSaveCurrentDraft(instance);
    const canActivate = canActivateCurrentProvider(instance);
    instance.root.dataset.busy = instance.busy || '';
    for (const element of instance.root.querySelectorAll('input, select, textarea, button')) {
      if (element.matches('[data-provider-confirm-answer]')) {
        element.disabled = false;
      } else if (element.matches('[data-provider-action="close"]')) {
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
    const draft = instance.draft || provider;
    return Boolean(!instance.templatePicker && !instance.modelEditor && provider?.kind === 'custom'
      && draft?.models?.length && draft.models.some(model => model.id === draft.defaultModelId));
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
      return instance.tx('Failed in this dialog', '本次测试失败') + (transient.errorCode ? ' · ' + transient.errorCode : '');
    }
    if (transient?.status === 'tested') {
      return instance.tx('Tested for this draft', '当前草稿已测试');
    }
    if (instance.verificationStale) return instance.tx('Settings changed; retest when ready', '配置已更改，可重新测试');
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
    const status = instance.verifications[modelId]?.status || (!instance.verificationStale && provider?.modelDiagnostics?.[modelId]?.status) || '';
    state.dataset.tone = status === 'failed' ? 'failed' : status === 'tested' ? 'success' : '';
    refreshModelStatuses(instance);
  }

  function getSelectedTestModelId(instance) {
    return String(instance.root.querySelector('[data-provider-test-model]')?.value || '').trim();
  }

  function getCurrentBaseUrl(instance) {
    return String(instance.root.querySelector('[data-provider-field="baseUrl"]')?.value || '').trim();
  }

  function syncPresetProtocol(instance, protocol) {
    const get = name => instance.root.querySelector('[data-provider-field="' + name + '"]');
    if (get('fullEndpoint')?.checked) return false;
    const info = instance.Profiles.getPresetConnectionInfo(get('baseUrl')?.value);
    const next = info && instance.Profiles.getPresetConnection(info.id, protocol);
    if (!next || next.baseUrl === info.connection.baseUrl) return false;
    get('baseUrl').value = next.baseUrl;
    // Respect manually overridden authentication and reasoning settings.
    for (const field of ['authMode', 'reasoningAdapter']) {
      const input = get(field);
      if (input?.value === info.connection[field]) input.value = next[field];
    }
    return true;
  }

  function updatePresetConnectionHint(instance) {
    const hint = instance.root.querySelector('[data-provider-connection-hint]');
    if (!hint) return;
    const info = instance.Profiles.getPresetConnectionInfo(getCurrentBaseUrl(instance));
    const protocol = instance.root.querySelector('[data-provider-field="wireApiPreference"]')?.value;
    let text = '';
    if (info && protocol !== 'auto' && protocol !== info.connection.wireApiPreference) {
      text = instance.tx('This preset address uses a different protocol. Enter an endpoint matching the selected API format.',
        '此预设地址与所选协议不同，请填写该协议对应的地址。');
    } else if (info?.id === 'kimi') {
      text = instance.tx('This is the Kimi Open Platform China endpoint. Kimi Code and international keys use their own endpoints.',
        '此处为 Kimi 开放平台中国站地址；Kimi Code 和国际站密钥需要各自对应的端点。');
    } else if (info?.id === 'glm' && info.connection.wireApiPreference === 'anthropic') {
      text = instance.tx('GLM Anthropic access and the standard pay-as-you-go API use different endpoints. Confirm the key has access to this endpoint; Chat uses the standard API.',
        'GLM Anthropic 接入与通用按量 API 的端点不同。请确认密钥具备此端点的权限；Chat 使用通用 API 地址。');
    }
    hint.textContent = text;
    hint.hidden = !text;
  }

  function updateDisclosureText(instance) {
    updatePresetConnectionHint(instance);
    const text = instance.root.querySelector('[data-provider-disclosure-text]');
    if (!text) return;
    const baseUrl = getCurrentBaseUrl(instance) || instance.tx('this endpoint', '此端点');
    text.textContent = instance.tx(
      `Projects using this shared provider may send task context to ${baseUrl}. Each project chooses its own provider.`,
      `使用此共享服务配置的项目可能把任务上下文发送到 ${baseUrl}。各项目独立选择使用的服务。`
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



  function providerTemplateTitle(instance, id) {
    if (id === 'kimi') return 'Kimi';
    if (id === 'glm') return 'GLM';
    if (id === 'deepseek') return 'DeepSeek';
    if (id === 'openai-compatible') return instance.tx('OpenAI-compatible API', 'OpenAI 兼容接口');
    if (id === 'anthropic-compatible') return instance.tx('Anthropic-compatible API', 'Anthropic 兼容接口');
    return instance.tx('Custom connection', '自定义连接');
  }

  function confirmProviderAction(instance, message, kind = 'discard') {
    if (!instance.root || instance.root.hidden || instance.confirmation) return Promise.resolve(false);
    const modal = instance.root.querySelector('[data-provider-confirmation]');
    if (!modal) return Promise.resolve(false);
    const tx = instance.tx;
    const titles = {
      discard: tx('Unsaved changes', '尚未保存的修改'),
      secret: tx('Remove API key?', '清除 API 密钥？'),
      provider: tx('Delete connection?', '删除连接？'),
      model: tx('Remove model?', '移除模型？')
    };
    const labels = {
      discard: tx('Discard changes', '放弃修改'),
      secret: tx('Remove key', '清除密钥'),
      provider: tx('Delete connection', '删除连接'),
      model: tx('Remove model', '移除模型')
    };
    const cancel = kind === 'discard' ? tx('Keep editing', '继续编辑') : tx('Cancel', '取消');
    const provider = getSelectedProvider(instance);
    return new Promise(resolve => {
      instance.confirmation = { resolve, selectedId: instance.selectedId,
        revision: provider?.revision || 0, returnFocus: instance.document.activeElement };
      modal.innerHTML = '<header><span class="codex-provider-confirm-brand">Codex Overleaf Link</span>'
        + '<h3 id="codex-provider-confirm-title">' + escapeHtml(titles[kind] || titles.discard) + '</h3></header>'
        + '<p id="codex-provider-confirm-message">' + escapeHtml(message) + '</p>'
        + '<footer><button type="button" class="codex-provider-secondary-button" data-provider-confirm-answer="cancel">'
        + escapeHtml(cancel) + '</button><button type="button" class="codex-provider-danger-button" data-provider-confirm-answer="confirm">'
        + escapeHtml(labels[kind] || labels.discard) + '</button></footer>';
      try {
        if (modal.showModal) modal.showModal(); else modal.setAttribute('open', '');
        modal.querySelector('[data-provider-confirm-answer="cancel"]')?.focus();
      } catch (_error) {
        finishProviderConfirmation(instance, false);
        setStatus(instance, { tone: 'failed', title: tx('The confirmation could not be opened. No changes were discarded.',
          '确认窗口无法打开，未丢弃任何修改。') });
      }
    });
  }

  function finishProviderConfirmation(instance, confirmed, restoreFocus = true) {
    const pending = instance.confirmation;
    if (!pending) return;
    instance.confirmation = null;
    const modal = instance.root?.querySelector('[data-provider-confirmation]');
    modal?.close?.();
    modal?.removeAttribute('open');
    modal?.replaceChildren();
    const sameTarget = Boolean(instance.root && !instance.root.hidden
      && instance.selectedId === pending.selectedId
      && (getSelectedProvider(instance)?.revision || 0) === pending.revision);
    pending.resolve(confirmed === true && sameTarget);
    if (restoreFocus) pending.returnFocus?.focus?.();
  }

  function renderProviderTemplateIcon(preset) {
    const vendorPath = PROVIDER_VENDOR_ICON_PATHS[preset.id] || '';
    const path = preset.id === 'openai-compatible' ? CODEX_BLOSSOM_PATH
      : preset.id === 'anthropic-compatible' ? ANTHROPIC_LOGO_PATH : vendorPath;
    return path
      ? '<svg class="codex-provider-brand-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill-rule="'
        + (vendorPath ? 'evenodd' : 'nonzero') + '" d="' + path + '"></path></svg>'
      : escapeHtml(preset.short || '+');
  }

  function renderTemplatePicker(instance, detail) {
    const tx = instance.tx;
    detail.innerHTML = '<div class="codex-provider-template-head"><button type="button" class="codex-provider-inline-button" data-provider-action="templates-back">'
      + escapeHtml(tx('Back', '返回')) + '</button><h3>' + escapeHtml(tx('Add a connection', '添加连接')) + '</h3></div>'
      + '<p class="codex-provider-help">' + escapeHtml(tx(
        'Service shortcuts default to Anthropic Messages. Chat Completions remains available; preset addresses follow the selected protocol. Add the matching API key and model IDs separately.',
        '服务快捷入口默认采用 Anthropic Messages，也可切换 Chat Completions，预设地址随协议联动。请另行填写对应密钥和模型 ID。')) + '</p>'
      + '<div class="codex-provider-template-grid">' + instance.Profiles.getProviderPresets().map(preset =>
        '<button type="button" class="codex-provider-template" data-provider-template="' + escapeAttr(preset.id) + '">'
        + '<span class="codex-provider-template-mark" aria-hidden="true">' + renderProviderTemplateIcon(preset) + '</span>'
        + '<span><strong>' + escapeHtml(providerTemplateTitle(instance, preset.id))
        + '</strong><small>' + escapeHtml(preset.id === 'custom' ? tx('Gateway or self-hosted API', '网关或自托管 API')
          : preset.baseUrl ? (preset.wireApiPreference === 'anthropic' ? 'Anthropic Messages' : 'Chat Completions') + ' · ' + getEndpointHost(preset.baseUrl)
            : preset.wireApiPreference === 'anthropic' ? 'Anthropic Messages'
            : preset.wireApiPreference === 'responses' ? 'OpenAI Responses' : 'Responses / Chat Completions')
        + '</small></span><span aria-hidden="true">›</span></button>').join('') + '</div>'
      + '<p class="codex-provider-help">' + escapeHtml(tx(
        'Adding or saving a connection does not switch the current project. Credentials remain with the Native Host.',
        '添加或保存连接不会切换当前项目。已保存的密钥仍由 Native Host 保管。')) + '</p>';
  }

  function modelButton(action, id, label, path, selected = false) {
    return '<button type="button" class="codex-provider-model-action" data-provider-model-action="'
      + action + '" data-model-id="' + escapeAttr(id) + '" title="' + escapeAttr(label)
      + '" aria-label="' + escapeAttr(label) + '"' + (selected ? ' data-selected="true"' : '') + '>'
      + '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="' + path + '"></path></svg></button>';
  }

  function renderModelList(instance) {
    const section = instance.root.querySelector('[data-provider-model-section]');
    if (!section) return;
    const tx = instance.tx, provider = getSelectedProvider(instance), draft = instance.draft || provider;
    const models = draft.models || [];
    section.innerHTML = '<div class="codex-provider-section-head"><div><h4>' + escapeHtml(tx('Models', '模型'))
      + ' <span>' + models.length + '/32</span></h4><p>' + escapeHtml(tx(
        'Model IDs are sent exactly as configured.', '模型 ID 将按配置原样发送。')) + '</p></div>'
      + '<button type="button" class="codex-provider-inline-button" data-provider-model-action="add">+ '
      + escapeHtml(tx('Add model', '添加模型')) + '</button></div>'
      + (models.length ? '<label class="codex-provider-search"><span class="codex-provider-sr-only">'
        + escapeHtml(tx('Search models', '搜索模型')) + '</span><input type="search" data-provider-model-search value="'
        + escapeAttr(instance.modelFilter) + '" placeholder="' + escapeAttr(tx('Search models', '搜索模型')) + '"></label>' : '')
      + '<div class="codex-provider-model-list">' + models.map(model => {
        const isDefault = model.id === draft.defaultModelId;
        const context = Number(model.contextWindow) || 262144;
        const facts = [
          context >= 1000000 ? (context / 1000000).toFixed(1).replace(/\.0$/, '') + 'M' : Math.round(context / 1024) + 'K',
          (model.inputModalities || []).includes('image') ? tx('Text + image', '文本与图像') : tx('Text', '文本')
        ];
        return '<div class="codex-provider-model-row" data-provider-model-row data-provider-model-search-text="'
          + escapeAttr((model.id + ' ' + model.label).toLowerCase()) + '">'
          + '<button type="button" class="codex-provider-model-identity" data-provider-model-action="edit" data-model-id="' + escapeAttr(model.id) + '">'
          + '<strong>' + escapeHtml(model.label || model.id) + (isDefault ? '<span class="codex-provider-default-tag">'
            + escapeHtml(tx('Default', '默认')) + '</span>' : '') + '</strong>'
          + (model.label && model.label !== model.id ? '<code>' + escapeHtml(model.id) + '</code>' : '')
          + '<small>' + escapeHtml(facts.join(' · ')) + '</small></button>'
          + '<div class="codex-provider-model-actions">'
          + modelButton('test', model.id, tx('Test ', '测试 ') + model.id, 'M7 4l9 6-9 6V4Z')
          + modelButton('default', model.id, tx('Set as default: ', '设为默认：') + model.id, 'm10 2 2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9L7.5 7Z', isDefault)
          + modelButton('remove', model.id, tx('Remove ', '移除 ') + model.id, 'M5 5l10 10M15 5 5 15')
          + '</div><span class="codex-provider-model-status" data-provider-model-status="' + escapeAttr(model.id) + '"></span></div>';
      }).join('') + '</div>'
      + (!models.length ? '<div class="codex-provider-model-empty">' + escapeHtml(tx(
        'Add the first model to finish this connection. No model is inferred from the provider name.',
        '添加第一个模型以完成配置。服务名称不会被当成模型 ID。')) + '</div>' : '')
      + '<p class="codex-provider-help" data-provider-model-no-results hidden>' + escapeHtml(tx('No matching models.', '没有匹配的模型。')) + '</p>';
    refreshModelStatuses(instance);
    filterModelRows(instance);
  }

  function filterModelRows(instance) {
    let visible = 0;
    const rows = instance.root.querySelectorAll('[data-provider-model-row]');
    for (const row of rows) {
      row.hidden = !row.dataset.providerModelSearchText.includes(instance.modelFilter.toLowerCase());
      if (!row.hidden) visible++;
    }
    const empty = instance.root.querySelector('[data-provider-model-no-results]');
    if (empty) empty.hidden = !rows.length || visible > 0;
  }

  function refreshModelStatuses(instance) {
    const provider = getSelectedProvider(instance);
    for (const element of instance.root.querySelectorAll('[data-provider-model-status]')) {
      const id = element.dataset.providerModelStatus;
      const testing = instance.busy === 'testing' && id === getSelectedTestModelId(instance);
      const status = instance.verifications[id]?.status
        || (!instance.verificationStale && provider?.modelDiagnostics?.[id]?.status) || '';
      element.textContent = testing ? instance.tx('Testing connection…', '正在测试连接…') : formatVerification(instance, provider, id);
      element.dataset.tone = testing ? 'progress' : status === 'tested' ? 'success' : status === 'failed' ? 'failed' : '';
    }
  }

  function replaceModelDraft(instance, next) {
    const secret = instance.root.querySelector('[data-provider-field="apiKey"]')?.value || '';
    const disclosure = instance.root.querySelector('[data-provider-disclosure]')?.checked === true;
    const advanced = instance.root.querySelector('.codex-provider-advanced')?.open === true;
    const detail = instance.root.querySelector('[data-provider-detail]');
    const scrollTop = detail?.scrollTop || 0;
    const selectedTest = getSelectedTestModelId(instance);
    instance.draft = { ...getSelectedProvider(instance), ...next };
    renderDetail(instance);
    const input = instance.root.querySelector('[data-provider-field="apiKey"]');
    if (input) input.value = secret;
    const checkbox = instance.root.querySelector('[data-provider-disclosure]');
    if (checkbox) checkbox.checked = disclosure;
    const advancedPanel = instance.root.querySelector('.codex-provider-advanced');
    if (advancedPanel) advancedPanel.open = advanced;
    const testSelect = instance.root.querySelector('[data-provider-test-model]');
    if (testSelect && next.models.some(model => model.id === selectedTest)) testSelect.value = selectedTest;
    if (detail) detail.scrollTop = scrollTop;
    markDirty(instance);
    renderFooter(instance);
    applyBusyState(instance);
  }

  async function handleModelAction(instance, action, id) {
    if (action === 'cancel-editor') { closeModelEditor(instance); return; }
    if (action === 'apply-editor') { commitModelEditor(instance); return; }
    if (action === 'add' || action === 'edit') { openModelEditor(instance, action === 'edit' ? id : ''); return; }
    if (action === 'test') {
      if (!validateConnectionForm(instance)) return;
      const select = instance.root.querySelector('[data-provider-test-model]');
      if (select) select.value = id;
      invalidateVerification(instance, false, id);
      instance.callbacks.onTest?.(readContext(instance));
      return;
    }
    const context = readContext(instance), draft = context.draft;
    if (!draft.models.some(model => model.id === id)) return;
    if (action === 'default') {
      if (draft.defaultModelId !== id) replaceModelDraft(instance, { ...draft, defaultModelId: id });
    } else if (action === 'remove' && await confirmProviderAction(instance, instance.tx(
      'Remove ' + id + ' from this provider? This takes effect after Save.',
      '从此服务移除 ' + id + '？保存后生效。'), 'model')) {
      replaceModelDraft(instance, instance.Profiles.removeDraftModel(draft, id));
    }
  }

  function openModelEditor(instance, id) {
    const provider = readContext(instance).draft;
    const existing = provider.models.find(model => model.id === id);
    if (id && !existing) return;
    const model = existing || { id: '', label: '', contextWindow: provider.contextWindow,
      maxOutputTokens: null, inputModalities: provider.inputModalities,
      supportsParallelToolCalls: provider.supportsParallelToolCalls,
      upstreamResponseMode: 'auto', reasoningEfforts: [], reasoningAdapter: '', reasoningCapability: '', baseInstructions: '' };
    const tx = instance.tx, modal = instance.root.querySelector('[data-provider-model-editor]');
    instance.modelEditor = { id, providerId: instance.selectedId, returnFocus: instance.document.activeElement };
    modal.classList.add('is-minimal');
    const field = (name, label, value, attributes = '', help = '') => '<label class="codex-provider-field"><span>'
      + escapeHtml(label) + '</span><input data-model-field="' + name + '" value="' + escapeAttr(value ?? '')
      + '" ' + attributes + '>' + (help ? '<small>' + escapeHtml(help) + '</small>' : '') + '</label>';
    const select = (name, label, value, options) => '<label class="codex-provider-field"><span>'
      + escapeHtml(label) + '</span><select data-model-field="' + name + '">'
      + options.map(([key, title]) => '<option value="' + key + '"' + (value === key ? ' selected' : '') + '>'
        + escapeHtml(title) + '</option>').join('') + '</select></label>';
    modal.innerHTML = '<header class="codex-provider-model-editor-head"><h3 id="codex-provider-model-title">'
      + escapeHtml(id ? tx('Edit model', '编辑模型') : tx('Add model', '添加模型'))
      + '</h3><button type="button" class="codex-provider-model-close" data-provider-model-action="cancel-editor" aria-label="'
      + escapeAttr(tx('Close model editor', '关闭模型编辑')) + '"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"></path></svg></button></header>'
      + '<div class="codex-provider-model-editor-body"><div class="codex-provider-model-basics">'
      + field('id', tx('Model ID', '模型 ID'), model.id, 'type="text" maxlength="200" spellcheck="false" autofocus placeholder="'
        + escapeAttr(tx('Exact model ID from the provider', '填写服务商提供的模型 ID')) + '"')
      + '<div class="codex-provider-form-grid">'
      + field('contextWindow', tx('Context window', '上下文窗口'), model.contextWindow, 'type="number" min="8192" max="4000000" step="1"')
      + field('maxOutputTokens', tx('Max output tokens', '最大输出 Token'), model.maxOutputTokens,
        'type="number" min="256" max="65536" placeholder="' + Number(provider.maxOutputTokens || 65536) + '"',
        tx('Optional; leave empty to inherit.', '可留空，沿用服务设置。'))
      + '</div><section class="codex-provider-model-types"><div class="codex-provider-model-types-head"><span>'
      + escapeHtml(tx('Input type', '输入类型')) + '</span><small>'
      + escapeHtml(tx('Output: text', '输出：文本')) + '</small></div><div class="codex-provider-type-options">'
      + '<span class="codex-provider-type-chip is-fixed" aria-label="' + escapeAttr(tx('Text input is required', '文本输入为必选项'))
      + '"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"></path></svg>'
      + escapeHtml(tx('Text', '文本')) + '<small>' + escapeHtml(tx('Required', '必选')) + '</small></span>'
      + '<label class="codex-provider-type-chip"><input type="checkbox" data-model-field="supportsImages"'
      + ((model.inputModalities || []).includes('image') ? ' checked' : '') + '><span>' + escapeHtml(tx('Images', '图片'))
      + '</span></label></div></section></div>'
      + '<details class="codex-provider-model-settings" data-model-reasoning><summary><span>'
      + escapeHtml(tx('Reasoning', '推理设置')) + '</span><small data-model-reasoning-summary></small></summary>'
      + '<div class="codex-provider-model-settings-body"><p class="codex-provider-help">'
      + escapeHtml(tx('Leave levels unchecked to use provider defaults. Only select levels supported by this endpoint.',
        '档位全部留空时沿用服务默认配置；仅选择该端点支持的档位。')) + '</p><div class="codex-provider-effort-chips">'
      + instance.Profiles.MODEL_EFFORTS.map(effort => '<label><input type="checkbox" data-model-effort value="' + effort + '"'
        + ((model.reasoningEfforts || []).includes(effort) ? ' checked' : '') + '><span>' + effort + '</span></label>').join('')
      + '</div><div class="codex-provider-form-grid">'
      + select('reasoningAdapter', tx('Parameter format', '参数格式'), model.reasoningAdapter || '',
        [['', tx('Inherit provider', '沿用服务配置')], ['auto', tx('Auto-detect', '自动识别')], ['none', tx('Disabled', '禁用')],
          ['deepseek', 'DeepSeek'], ['anthropic', 'Anthropic'], ['reasoning_effort', 'reasoning_effort'],
          ['openrouter', 'OpenRouter'], ['enable_thinking', 'enable_thinking'], ['thinking', 'thinking.type'], ['reasoning_split', 'reasoning_split']])
      + select('reasoningCapability', tx('Reasoning control', '推理控制'), model.reasoningCapability || '',
        [['', tx('Inherit / selected levels', '继承或使用所选档位')], ['none', tx('Not supported', '不支持')],
          ['toggle', tx('On / Off', '开启／关闭')], ['effort', tx('Effort levels', '档位选择')]])
      + '</div></div></details><details class="codex-provider-model-settings"><summary><span>'
      + escapeHtml(tx('Advanced', '高级设置')) + '</span><small>'
      + escapeHtml(tx('Name and compatibility', '名称与兼容性')) + '</small></summary>'
      + '<div class="codex-provider-model-settings-body"><div class="codex-provider-form-grid">'
      + field('label', tx('Display name (optional)', '显示名称（可选）'), model.label, 'type="text" maxlength="200"')
      + select('upstreamResponseMode', tx('Response mode', '响应模式'), model.upstreamResponseMode || 'auto',
        [['auto', tx('Auto', '自动')], ['streaming', tx('Streaming', '流式')], ['buffered', tx('Buffered', '缓冲')]])
      + '</div><label class="codex-provider-model-checkbox"><input type="checkbox" data-model-field="supportsParallelToolCalls"'
      + (model.supportsParallelToolCalls ? ' checked' : '') + '> ' + escapeHtml(tx('Parallel tool calls', '并行工具调用')) + '</label>'
      + '<label class="codex-provider-field"><span>' + escapeHtml(tx('Base instructions (optional)', '基础指令（可选）'))
      + '</span><textarea data-model-field="baseInstructions" rows="3" maxlength="8000">' + escapeHtml(model.baseInstructions || '')
      + '</textarea></label></div></details><p role="alert" class="codex-provider-model-error" data-model-error></p></div>'
      + '<footer class="codex-provider-model-editor-foot"><small>' + escapeHtml(tx('Saved with the provider.', '随服务配置一起保存。'))
      + '</small><button type="button" class="codex-provider-secondary-button" data-provider-model-action="cancel-editor">'
      + escapeHtml(tx('Cancel', '取消')) + '</button><button type="button" class="codex-provider-primary-button" data-provider-model-action="apply-editor">'
      + escapeHtml(id ? tx('Apply', '应用') : tx('Add model', '添加模型')) + '</button></footer>';
    updateModelReasoningSummary(instance);
    if (modal.showModal) modal.showModal(); else modal.setAttribute('open', '');
  }

  function updateModelReasoningSummary(instance) {
    const modal = instance.root.querySelector('[data-provider-model-editor]');
    const summary = modal?.querySelector('[data-model-reasoning-summary]');
    if (!summary) return;
    const capability = modal.querySelector('[data-model-field="reasoningCapability"]')?.value;
    const adapter = modal.querySelector('[data-model-field="reasoningAdapter"]')?.value;
    const levels = Array.from(modal.querySelectorAll('[data-model-effort]:checked')).map(input => input.value);
    summary.textContent = capability === 'none' || adapter === 'none' ? instance.tx('Disabled', '已关闭')
      : levels.length ? levels.join(' · ')
        : capability === 'toggle' ? instance.tx('On / Off', '开关控制')
          : adapter && adapter !== 'auto' ? adapter
            : capability === 'effort' ? instance.tx('Provider levels', '服务默认档位')
              : instance.tx('Provider defaults', '沿用服务配置');
    summary.title = summary.textContent;
  }

  function closeModelEditor(instance, restoreFocus = true) {
    if (!instance.modelEditor) return;
    const focus = instance.modelEditor.returnFocus;
    const modal = instance.root?.querySelector('[data-provider-model-editor]');
    instance.modelEditor = null;
    modal?.close?.();
    modal?.removeAttribute('open');
    if (modal) modal.replaceChildren();
    if (restoreFocus) focus?.focus?.();
  }

  function commitModelEditor(instance) {
    const editor = instance.modelEditor;
    if (!editor || editor.providerId !== instance.selectedId) return;
    const modal = instance.root.querySelector('[data-provider-model-editor]');
    const get = key => modal.querySelector('[data-model-field="' + key + '"]');
    const patch = Object.fromEntries(['id', 'label', 'contextWindow', 'maxOutputTokens',
      'upstreamResponseMode', 'reasoningAdapter', 'reasoningCapability', 'baseInstructions']
      .map(key => [key, get(key)?.value || '']));
    patch.inputModalities = get('supportsImages')?.checked ? ['text', 'image'] : ['text'];
    patch.supportsParallelToolCalls = get('supportsParallelToolCalls')?.checked === true;
    patch.reasoningEfforts = Array.from(modal.querySelectorAll('[data-model-effort]:checked')).map(input => input.value);
    try {
      const draft = readContext(instance).draft;
      const next = instance.Profiles.updateDraftModel(draft, editor.id, patch);
      const unchanged = JSON.stringify(next.models) === JSON.stringify(draft.models)
        && next.defaultModelId === draft.defaultModelId;
      closeModelEditor(instance, false);
      if (!unchanged) replaceModelDraft(instance, next);
    } catch (error) {
      const translated = {
        id: instance.tx(error.message, '请检查模型 ID：必填、最多 200 字符、不可重复，且单个服务最多 32 个模型。'),
        contextWindow: instance.tx(error.message, '上下文窗口必须为 8192 至 4000000 之间的整数。'),
        maxOutputTokens: instance.tx(error.message, '输出上限须为 256 至 65536 之间的整数，并小于上下文窗口。')
      };
      modal.querySelector('[data-model-error]').textContent = translated[error.field] || error.message;
      if (error.field) get(error.field)?.focus();
    }
  }

  function validateConnectionForm(instance) {
    const context = readContext(instance), tx = instance.tx;
    let message = '';
    if (!context.draft.name) message = tx('Enter a provider name.', '请填写服务名称。');
    else if (!context.draft.baseUrl) message = tx('Enter the API Base URL.', '请填写 API 地址。');
    else if (!context.draft.models.length || !context.draft.models.some(model => model.id === context.draft.defaultModelId))
      message = tx('Add at least one model and select a default.', '请添加至少一个模型，并选择默认模型。');
    if (message) { setStatus(instance, { tone: 'failed', title: message }); return false; }
    return true;
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
    instance.root.dataset.theme = panel.dataset.theme === 'light' ? 'light' : 'dark';
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
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) {
      return '';
    }
    return JSON.stringify(value, null, 2);
  }

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll('`', '&#96;');
  }

  function destroy(instance) {
    finishProviderConfirmation(instance, false, false);
    closeModelEditor(instance, false);
    instance.root?.close?.();
    instance.root?.remove?.();
    instance.root = null;
  }

  window.CodexOverleafProviderSettingsDialog = { create, getFooterActionState };
})();
