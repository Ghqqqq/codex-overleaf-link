(function initOverleafCapabilities(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafPageCapabilities = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function overleafCapabilitiesFactory() {
  'use strict';

  function collectPageCapabilities(deps = {}) {
    const editor = deps.editor || deps.detectEditor?.() || {};
    const warnings = [];
    const editorRead = Boolean(editor?.ok);
    const editorWrite = canWriteActiveEditor(deps);
    const fileTreeWrite = hasFileTreeWriteCapability(deps);
    const checkpointWrite = hasCheckpointCapability(deps);
    const compileCapture = Boolean(deps.compileState?.capturedRequestTemplate);
    const reviewingControl = Boolean(deps.findReviewingActivationControl?.());
    const upgradeModal = Boolean(deps.findUpgradeModal?.());

    if (!editorRead) {
      warnings.push('没有识别到当前 Overleaf 编辑器，Codex 不能读取当前文件。');
    }
    if (!editorWrite) {
      warnings.push('没有识别到可写编辑器，Codex 不能自动写回 Overleaf。');
    }
    if (!fileTreeWrite) {
      warnings.push('没有识别到可用文件树 API，新建、重命名、移动、删除可能不可用。');
    }
    if (!compileCapture) {
      warnings.push('还没有捕获到 Overleaf 编译请求，@compile-log 需要先手动编译一次或由 Codex 触发。');
    }

    return {
      editor: {
        read: editorRead,
        write: editorWrite,
        type: editor?.type || 'unknown'
      },
      fileTree: {
        write: fileTreeWrite
      },
      checkpoint: {
        write: checkpointWrite
      },
      compile: {
        capture: compileCapture,
        trigger: compileCapture
      },
      reviewing: {
        control: reviewingControl,
        upgradeModal,
        confirmed: !upgradeModal && deps.reviewingConfirmed === true
      },
      warnings
    };
  }

  function canWriteActiveEditor(deps = {}) {
    const editorView = deps.getCodeMirrorEditorView?.();
    if (editorView && typeof editorView.dispatch === 'function') {
      return true;
    }
    const active = deps.getDeepActiveElement?.();
    if (active?.tagName === 'TEXTAREA' && !deps.isInsideCodexPanel?.(active)) {
      return true;
    }
    if (deps.findEditorTextArea?.()) {
      return true;
    }
    return Boolean(deps.findEditorContentNode?.('.cm-content')
      || deps.findEditorContentNode?.('[contenteditable="true"]'));
  }

  function hasFileTreeWriteCapability(deps = {}) {
    const manager = deps.findFileTreeManager?.();
    if (!manager) {
      return false;
    }
    return ['create', 'rename', 'move', 'delete']
      .some(type => deps.fileTreeMethodNames?.(type).some(methodName => typeof manager[methodName] === 'function'));
  }

  function hasCheckpointCapability(deps = {}) {
    const pageWindow = deps.window || {};
    const history = deps.findHistoryObject?.();
    return [
      history?.labelCurrentVersion,
      history?.createLabel,
      history?.addLabel,
      pageWindow._ide?.projectHistoryManager?.labelCurrentVersion,
      pageWindow._ide?.historyManager?.labelCurrentVersion,
      pageWindow.Overleaf?.history?.labelCurrentVersion
    ].some(fn => typeof fn === 'function');
  }

  return {
    canWriteActiveEditor,
    collectPageCapabilities,
    hasCheckpointCapability,
    hasFileTreeWriteCapability
  };
});
