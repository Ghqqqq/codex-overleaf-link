(function initUpdateLoader(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafUpdateLoader = api;
  if (root?.document && root?.chrome?.runtime) {
    api.start(root).catch(function (error) {
      api.renderLoadFailure(root.document, error);
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function updateLoaderFactory() {
  'use strict';

  function resolveProjectionPath(serviceWorkerPath) {
    var normalized = String(serviceWorkerPath || '').replace(/^\/+/, '');
    return normalized.startsWith('bootstrap/')
      ? '../runtime/src/shared/managedUpdateProjection.js'
      : '../src/shared/managedUpdateProjection.js';
  }

  async function loadForWorker(serviceWorkerPath, loadScript) {
    if (typeof loadScript !== 'function') {
      throw new TypeError('loadScript must be a function');
    }
    await loadScript(resolveProjectionPath(serviceWorkerPath));
    await loadScript('update.js');
  }

  function appendScript(documentObject, source) {
    return new Promise(function (resolve, reject) {
      var script = documentObject.createElement('script');
      script.src = source;
      script.async = false;
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', function () {
        reject(new Error('Could not load Update Center runtime: ' + source));
      }, { once: true });
      (documentObject.head || documentObject.documentElement).appendChild(script);
    });
  }

  async function start(environment) {
    var manifest = environment.chrome.runtime.getManifest();
    var workerPath = manifest?.background?.service_worker || '';
    await loadForWorker(workerPath, function (source) {
      return appendScript(environment.document, source);
    });
  }

  function renderLoadFailure(documentObject, error) {
    if (!documentObject?.body || documentObject.querySelector('[data-update-bootstrap-error]')) {
      return;
    }
    var message = documentObject.createElement('p');
    message.dataset.updateBootstrapError = 'true';
    message.setAttribute('role', 'alert');
    message.textContent = 'Update Center could not start. Reload the extension and try again.';
    message.title = String(error?.message || error || '');
    documentObject.body.appendChild(message);
  }

  return Object.freeze({
    resolveProjectionPath: resolveProjectionPath,
    loadForWorker: loadForWorker,
    appendScript: appendScript,
    start: start,
    renderLoadFailure: renderLoadFailure
  });
});
