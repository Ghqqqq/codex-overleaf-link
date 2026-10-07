(function installUpdateSafetyProbe(root) {
  'use strict';
  if (root.CodexOverleafUpdateSafetyProbe?.revision === '1') return;
  const identities = new WeakMap();
  function identity(value) {
    if (!identities.has(value)) identities.set(value, crypto.randomUUID());
    return identities.get(value);
  }
  // The same full CodeMirror document sources used by pageBridge. No DOM
  // viewport text is eligible for the quiet-save fallback.
  function editorView() {
    const store = root.overleaf?.unstable?.store || root.Overleaf?.unstable?.store;
    const get = key => { try { return store?.get?.(key) || {}; } catch (_) { return {}; } };
    return [get('editor.view'), get('editor.view.camel'), get('editor').view,
      root.overleaf?.unstable?.editorView, root.Overleaf?.editorView, root._ide?.editorView]
      .find(value => value && typeof value.dispatch === 'function' && value.state?.doc
        && typeof value.state.doc.toString === 'function') || null;
  }
  function fileIdentity() {
    const store = root.overleaf?.unstable?.store || root.Overleaf?.unstable?.store;
    const get = key => { try { return store?.get?.(key); } catch (_) { return ''; } };
    const selected = document.querySelector('[role="treeitem"][aria-selected="true"] [data-file-id]');
    return [get('editor.open_doc_id'), get('editor.openDocId'), root._ide?.editor?.open_doc_id,
      root._ide?.editor?.openDocId, selected?.getAttribute('data-file-id'),
      get('editor.open_doc_name'), get('editor.openDocName')].find(value => typeof value === 'string' && value) || '';
  }
  async function probe(expectedUrl) {
    const view = editorView(), doc = view?.state?.doc, file = fileIdentity();
    if (location.href !== expectedUrl || !file || !root.CodexOverleafSaveState) return { ok: false, state: 'unavailable' };
    const save = root.CodexOverleafSaveState.create({ window: root, document,
      delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
      detectEditor: () => ({ ok: Boolean(view && editorView() === view && view.state.doc === doc) }),
      getActiveFilePath: () => doc ? identity(doc) : '', readActiveEditorText: () => view?.state.doc.toString() || '' });
    const result = await save.waitForSaveState({ deadlineMs: 1500, pollIntervalMs: 100,
      requirePositiveSignal: true, allowQuietEditorFallback: Boolean(doc), quietFallbackMs: 1000 });
    if (location.href !== expectedUrl || fileIdentity() !== file || editorView() !== view
      || (view && view.state.doc !== doc)) return { ok: false, state: 'unavailable' };
    return { ok: result.ok === true, state: result.state, identity: file + ':' + (doc ? identity(doc) : 'positive-save-signal') };
  }
  root.CodexOverleafUpdateSafetyProbe = Object.freeze({ revision: '1', probe });
})(globalThis);
