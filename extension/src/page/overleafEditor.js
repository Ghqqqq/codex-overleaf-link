(function initOverleafEditor(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafEditorAdapter = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function overleafEditorFactory() {
  'use strict';

  function create(deps = {}) {
    function detectEditor() {
      if (deps.getCodeMirrorEditorView?.()) {
        return {
          ok: true,
          type: 'codemirror-view'
        };
      }
      if (deps.findEditorTextArea?.()) {
        return {
          ok: true,
          type: 'textarea'
        };
      }
      if (deps.findEditorContentNode?.('.cm-content')) {
        return {
          ok: true,
          type: 'codemirror'
        };
      }
      if (deps.findEditorContentNode?.('[contenteditable="true"]')) {
        return {
          ok: true,
          type: 'contenteditable'
        };
      }
      return {
        ok: false,
        type: 'unknown'
      };
    }

    function readActiveEditorText() {
      const editorView = deps.getCodeMirrorEditorView?.();
      if (editorView) {
        return deps.getCodeMirrorDocText(editorView);
      }

      const active = deps.getDeepActiveElement?.();
      if (active && active.tagName === 'TEXTAREA' && !deps.isInsideCodexPanel?.(active)) {
        return active.value;
      }

      const textarea = deps.findEditorTextArea?.();
      if (textarea) {
        return textarea.value;
      }

      const cm = deps.findEditorContentNode?.('.cm-content');
      if (cm) {
        return cm.innerText || cm.textContent || '';
      }

      const editable = deps.findEditorContentNode?.('[contenteditable="true"]');
      if (editable) {
        return editable.innerText || editable.textContent || '';
      }

      return '';
    }

    function captureMatches(view, capture) {
      return !capture || (view === capture.view && view?.state === capture.state && view.state.doc === capture.doc
        && view.state.doc.toString() === capture.text);
    }

    function replaceActiveEditorText(text, options = {}) {
      const editorView = deps.getCodeMirrorEditorView?.();
      if (!captureMatches(editorView, options.expectedCapture))
        return { ok: false, code: 'document_identity_mismatch', changedDocument: false };
      if (editorView) {
        const from = 0;
        const to = deps.getCodeMirrorDocLength(editorView);
        editorView.dispatch({
          changes: {
            from,
            to,
            insert: text
          }
        });
        return {
          ok: true,
          method: 'codemirror-view'
        };
      }

      const active = deps.getDeepActiveElement?.();
      const textarea = active?.tagName === 'TEXTAREA' && !deps.isInsideCodexPanel?.(active)
        ? active
        : deps.findEditorTextArea?.();

      if (textarea) {
        textarea.focus();
        textarea.value = text;
        textarea.dispatchEvent(new deps.InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }));
        textarea.dispatchEvent(new deps.Event('change', { bubbles: true }));
        return {
          ok: true,
          method: 'textarea'
        };
      }

      const editable = deps.findEditorContentNode?.('.cm-content') || deps.findEditorContentNode?.('[contenteditable="true"]');
      if (editable) {
        editable.focus();
        deps.document.execCommand('selectAll', false, null);
        deps.document.execCommand('insertText', false, text);
        editable.dispatchEvent(new deps.InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }));
        return {
          ok: true,
          method: 'contenteditable'
        };
      }

      return {
        ok: false,
        reason: 'No editable surface was detected'
      };
    }

    function replaceActiveEditorPatches(patches, nextContent, options = {}) {
      const normalized = deps.normalizeTextPatches(patches, readActiveEditorText().length);
      if (!normalized.ok) {
        return normalized;
      }

      const editorView = deps.getCodeMirrorEditorView?.();
      if (!captureMatches(editorView, options.expectedCapture))
        return { ok: false, code: 'document_identity_mismatch', changedDocument: false };
      if (editorView) {
        editorView.dispatch({
          changes: normalized.patches.map(patch => ({
            from: patch.from,
            to: patch.to,
            insert: patch.insert
          }))
        });
        return {
          ok: true,
          method: 'codemirror-view-patch'
        };
      }

      const active = deps.getDeepActiveElement?.();
      const textarea = active?.tagName === 'TEXTAREA' && !deps.isInsideCodexPanel?.(active)
        ? active
        : deps.findEditorTextArea?.();

      if (textarea && typeof textarea.setRangeText === 'function') {
        textarea.focus();
        for (const patch of normalized.patches.slice().sort((left, right) => right.from - left.from)) {
          textarea.setRangeText(patch.insert, patch.from, patch.to, 'end');
        }
        textarea.dispatchEvent(new deps.InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: '' }));
        textarea.dispatchEvent(new deps.Event('change', { bubbles: true }));
        return {
          ok: true,
          method: 'textarea-patch'
        };
      }

      const result = replaceActiveEditorText(nextContent, options);
      return result.ok
        ? {
          ...result,
          method: `${result.method}-patch-fallback`
        }
        : result;
    }

    function focusActiveEditorRange(from, to) {
      const range = normalizeSelectionRange(from, to);
      if (!range.ok) {
        return range;
      }

      const editorView = deps.getCodeMirrorEditorView?.();
      if (editorView) {
        const length = getKnownCodeMirrorDocLength(editorView);
        if (Number.isInteger(length) && !isSelectionRangeInBounds(range, length)) {
          return rangeOutOfBounds(range, length);
        }
        editorView.focus?.();
        editorView.dispatch({
          selection: {
            anchor: range.from,
            head: range.to
          },
          scrollIntoView: true
        });
        return {
          ok: true,
          method: 'codemirror-view-selection'
        };
      }

      const active = deps.getDeepActiveElement?.();
      const textarea = active?.tagName === 'TEXTAREA' && !deps.isInsideCodexPanel?.(active)
        ? active
        : deps.findEditorTextArea?.();

      if (textarea) {
        const length = typeof textarea.value === 'string' ? textarea.value.length : null;
        if (Number.isInteger(length) && !isSelectionRangeInBounds(range, length)) {
          return rangeOutOfBounds(range, length);
        }
        textarea.focus();
        textarea.setSelectionRange(range.from, range.to);
        return {
          ok: true,
          method: 'textarea-selection'
        };
      }

      const editable = deps.findEditorContentNode?.('.cm-content') || deps.findEditorContentNode?.('[contenteditable="true"]');
      if (editable) {
        editable.focus();
        return {
          ok: true,
          method: 'selection-fallback'
        };
      }

      return {
        ok: false,
        code: 'editor_not_found',
        reason: 'No editable surface was detected'
      };
    }

    function normalizeSelectionRange(from, to) {
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0) {
        return {
          ok: false,
          code: 'invalid_range',
          reason: 'Selection offsets must be non-negative integers'
        };
      }
      return {
        ok: true,
        from,
        to
      };
    }

    function getKnownCodeMirrorDocLength(editorView) {
      try {
        const length = deps.getCodeMirrorDocLength?.(editorView);
        return Number.isInteger(length) ? length : null;
      } catch (_error) {
        return null;
      }
    }

    function isSelectionRangeInBounds(range, length) {
      return range.from <= length && range.to <= length;
    }

    function rangeOutOfBounds(range, length) {
      return {
        ok: false,
        code: 'range_out_of_bounds',
        reason: `Selection offsets are out of range for document length ${length}`,
        from: range.from,
        to: range.to,
        length
      };
    }

    return {
      detectEditor,
      focusActiveEditorRange,
      readActiveEditorText,
      replaceActiveEditorPatches,
      replaceActiveEditorText
    };
  }

  return {
    create
  };
});
