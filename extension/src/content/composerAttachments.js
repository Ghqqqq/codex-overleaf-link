(function initComposerAttachments(global) {
  'use strict';

  function createComposerAttachmentController(options = {}) {
    const getPanel = typeof options.getPanel === 'function' ? options.getPanel : () => null;
    const tx = typeof options.tx === 'function' ? options.tx : (en) => en;
    const tr = typeof options.tr === 'function' ? options.tr : (key) => key;
    const appendPlainLog = typeof options.appendPlainLog === 'function' ? options.appendPlainLog : () => {};
    const limits = options.limits || {};
    const maxAttachments = Number(limits.maxAttachments) || 8;
    const maxAttachmentBytes = Number(limits.maxAttachmentBytes) || 12 * 1024 * 1024;
    const maxAttachmentTotalBytes = Number(limits.maxAttachmentTotalBytes) || 32 * 1024 * 1024;
    const maxPreviewDataUrlChars = Number(limits.maxPreviewDataUrlChars) || 768 * 1024;

    let attachments = [];
    const pendingAttachmentKeys = new Set();
    let pendingAttachmentBytes = 0;

    function handlePaste(event) {
      const files = collectFilesFromDataTransfer(event.clipboardData);
      if (!files.length) {
        return;
      }
      event.preventDefault();
      addFiles(files).catch(error => {
        appendPlainLog(tx(`Attachment was not added: ${error.message}`, `附件没有添加：${error.message}`));
      });
    }

    function handleDragOver(event) {
      if (!hasFileDataTransfer(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      getPanel()?.querySelector('[data-composer-form]')?.setAttribute('data-dragging-attachment', 'true');
    }

    function handleDragLeave(event) {
      const composer = getPanel()?.querySelector('[data-composer-form]');
      if (!composer || (event.relatedTarget && composer.contains(event.relatedTarget))) {
        return;
      }
      composer.removeAttribute('data-dragging-attachment');
    }

    function handleDrop(event) {
      const files = collectFilesFromDataTransfer(event.dataTransfer);
      getPanel()?.querySelector('[data-composer-form]')?.removeAttribute('data-dragging-attachment');
      if (!files.length) {
        return;
      }
      event.preventDefault();
      addFiles(files).catch(error => {
        appendPlainLog(tx(`Attachment was not added: ${error.message}`, `附件没有添加：${error.message}`));
      });
    }

    async function addFiles(files) {
      for (const file of Array.from(files || [])) {
        const dedupeKey = buildAttachmentDedupeKey(file);
        if (isDuplicateAttachmentFile(dedupeKey)) {
          continue;
        }
        if (attachments.length + pendingAttachmentKeys.size >= maxAttachments) {
          appendPlainLog(tx(
            `Attachment limit reached (${maxAttachments}).`,
            `附件数量已达上限（${maxAttachments} 个）。`
          ));
          break;
        }
        validateAttachmentFile(file);
        const fileSize = Number(file.size) || 0;
        if (!canReserveAttachmentBytes(fileSize)) {
          appendPlainLog(tx(
            `Attachment total limit reached (${formatFileSize(maxAttachmentTotalBytes)}). Remove attachments or use smaller files.`,
            `附件总大小已达上限（${formatFileSize(maxAttachmentTotalBytes)}）。请移除部分附件或使用更小的文件。`
          ));
          continue;
        }
        pendingAttachmentKeys.add(dedupeKey);
        pendingAttachmentBytes += fileSize;
        try {
          const dataUrl = await readFileAsDataUrl(file);
          const preview = await buildAttachmentPreviewData(file, dataUrl);
          const attachment = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name: normalizeAttachmentName(file.name),
            mimeType: String(file.type || ''),
            size: Number(file.size) || 0,
            kind: preview.kind,
            previewDataUrl: preview.previewDataUrl,
            contentBase64: extractBase64FromDataUrl(dataUrl),
            dedupeKey
          };
          if (!attachments.some(existing => buildAttachmentDedupeKey(existing) === dedupeKey)) {
            attachments.push(attachment);
          }
        } finally {
          pendingAttachmentBytes = Math.max(0, pendingAttachmentBytes - fileSize);
          pendingAttachmentKeys.delete(dedupeKey);
        }
      }
      renderComposerAttachments();
    }

    function getAttachmentsForRun() {
      return attachments.map(attachment => ({
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        kind: attachment.kind,
        previewDataUrl: attachment.previewDataUrl,
        contentBase64: attachment.contentBase64
      }));
    }

    function createRunAttachmentSnapshots(value = []) {
      return Array.from(value || []).map(attachment => ({
        name: normalizeAttachmentName(attachment.name),
        mimeType: String(attachment.mimeType || '').trim(),
        size: Number(attachment.size) || 0,
        kind: attachment.kind === 'image' ? 'image' : 'file',
        previewDataUrl: attachment.kind === 'image' && /^data:image\//i.test(String(attachment.previewDataUrl || ''))
          ? String(attachment.previewDataUrl || '').slice(0, maxPreviewDataUrlChars)
          : ''
      })).filter(attachment => attachment.name).slice(0, maxAttachments);
    }

    function renderComposerAttachments() {
      const strip = getPanel()?.querySelector('[data-attachment-strip]');
      if (!strip) {
        return;
      }
      strip.hidden = attachments.length === 0;
      renderAttachmentPreviewList(attachments, strip, {
        root: getPanel() || document.body,
        tr,
        tx,
        removable: true,
        onRemove: removeAttachment
      });
    }

    function clear() {
      attachments = [];
      pendingAttachmentKeys.clear();
      renderComposerAttachments();
    }

    function removeAttachment(id) {
      attachments = attachments.filter(attachment => attachment.id !== id);
      renderComposerAttachments();
    }

    function isDuplicateAttachmentFile(dedupeKey) {
      const key = String(dedupeKey || '');
      return pendingAttachmentKeys.has(key) ||
        attachments.some(attachment => buildAttachmentDedupeKey(attachment) === key);
    }

    function canReserveAttachmentBytes(size) {
      return getCommittedAttachmentBytes() + pendingAttachmentBytes + size <= maxAttachmentTotalBytes;
    }

    function getCommittedAttachmentBytes() {
      return attachments.reduce((total, attachment) => total + (Number(attachment.size) || 0), 0);
    }

    function validateAttachmentFile(file) {
      if (!file || !normalizeAttachmentName(file.name)) {
        throw new Error(tx('The selected attachment has no readable file name.', '选择的附件没有可读取的文件名。'));
      }
      if (Number(file.size) <= 0) {
        throw new Error(tx('Empty attachments are not supported.', '不支持空附件。'));
      }
      if (Number(file.size) > maxAttachmentBytes) {
        throw new Error(tx('Selected attachment is too large.', '选择的附件太大。'));
      }
    }

    function buildAttachmentPreviewData(file, dataUrl) {
      const mimeType = String(file?.type || '');
      const name = normalizeAttachmentName(file?.name);
      if (!isImageAttachment({ name, mimeType })) {
        return Promise.resolve({ kind: 'file', previewDataUrl: '' });
      }
      return createScaledImagePreviewDataUrl(dataUrl).catch(() => '').then(scaled => {
        const fallback = String(dataUrl || '').length <= maxPreviewDataUrlChars ? String(dataUrl || '') : '';
        return {
          kind: 'image',
          previewDataUrl: scaled || fallback
        };
      });
    }

    function createScaledImagePreviewDataUrl(dataUrl) {
      return new Promise(resolve => {
        if (typeof Image === 'undefined' || typeof document === 'undefined' || !/^data:image\//i.test(String(dataUrl || ''))) {
          resolve('');
          return;
        }
        const image = new Image();
        image.onload = () => {
          const width = Number(image.naturalWidth || image.width);
          const height = Number(image.naturalHeight || image.height);
          if (!width || !height) {
            resolve('');
            return;
          }
          const maxEdge = 960;
          const scale = Math.min(1, maxEdge / Math.max(width, height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          const context = canvas.getContext('2d');
          if (!context) {
            resolve('');
            return;
          }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const value = canvas.toDataURL('image/png');
          resolve(value.length <= maxPreviewDataUrlChars ? value : '');
        };
        image.onerror = () => resolve('');
        image.src = dataUrl;
      });
    }

    // v1.8.0 C4: survive a page refresh. Only small attachments persist
    // (single base64 <= 1MB, max 3) — oversized ones are dropped on restore
    // rather than bloating chrome.storage and every debounced saveState.
    const PERSIST_MAX_CONTENT_CHARS = 1024 * 1024;
    const PERSIST_MAX_COUNT = 3;

    function serializePersistableAttachments() {
      return attachments
        .filter(attachment => (attachment.contentBase64 || '').length <= PERSIST_MAX_CONTENT_CHARS)
        .slice(0, PERSIST_MAX_COUNT)
        .map(attachment => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          kind: attachment.kind,
          previewDataUrl: attachment.previewDataUrl,
          contentBase64: attachment.contentBase64,
          dedupeKey: attachment.dedupeKey
        }));
    }

    function restorePersistedAttachments(persisted) {
      const usable = (Array.isArray(persisted) ? persisted : [])
        .filter(item => item && item.name && typeof item.contentBase64 === 'string'
          && item.contentBase64.length > 0
          && item.contentBase64.length <= PERSIST_MAX_CONTENT_CHARS)
        .slice(0, PERSIST_MAX_COUNT);
      if (!usable.length) {
        return 0;
      }
      attachments = usable.map(item => ({ ...item }));
      renderComposerAttachments();
      return attachments.length;
    }

    return {
      serializePersistableAttachments,
      restorePersistedAttachments,
      handlePaste,
      handleDragOver,
      handleDragLeave,
      handleDrop,
      addFiles,
      getAttachmentByteUsage: () => ({
        committed: getCommittedAttachmentBytes(),
        pending: pendingAttachmentBytes,
        limit: maxAttachmentTotalBytes
      }),
      getAttachmentsForRun,
      createRunAttachmentSnapshots,
      renderComposerAttachments,
      renderAttachmentPreviewList: (value, container, options = {}) => renderAttachmentPreviewList(value, container, {
        root: getPanel() || document.body,
        tr,
        tx,
        ...options
      }),
      clear,
      _private: {
        collectFilesFromDataTransfer,
        normalizeAttachmentName,
        buildAttachmentDedupeKey,
        isDuplicateAttachmentFile,
        validateAttachmentFile
      }
    };
  }

  function collectFilesFromDataTransfer(dataTransfer) {
    const addFile = (target, seen, file) => {
      if (!file) {
        return;
      }
      const key = [
        normalizeAttachmentName(file.name).toLowerCase(),
        String(file.type || '').trim().toLowerCase(),
        Number(file.size) || 0,
        Number(file.lastModified) || 0
      ].join('\n');
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      target.push(file);
    };
    const itemFiles = [];
    const seenItemFiles = new Set();
    for (const item of Array.from(dataTransfer?.items || [])) {
      if (item?.kind !== 'file' || typeof item.getAsFile !== 'function') {
        continue;
      }
      addFile(itemFiles, seenItemFiles, item.getAsFile());
    }
    if (itemFiles.length) {
      return itemFiles;
    }
    const files = [];
    const seenFiles = new Set();
    for (const file of Array.from(dataTransfer?.files || [])) {
      addFile(files, seenFiles, file);
    }
    return files;
  }

  function hasFileDataTransfer(dataTransfer) {
    return Array.from(dataTransfer?.items || []).some(item => item?.kind === 'file') ||
      Array.from(dataTransfer?.types || []).includes('Files') ||
      Array.from(dataTransfer?.files || []).length > 0;
  }

  function buildAttachmentDedupeKey(file) {
    const input = file || {};
    return [
      normalizeAttachmentName(input.name).toLowerCase(),
      String(input.type || input.mimeType || '').trim().toLowerCase(),
      Number(input.size) || 0
    ].join('\n');
  }

  function normalizeAttachmentName(name) {
    return String(name || '')
      .replace(/\0/g, '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .pop()
      ?.trim()
      .slice(0, 180) || '';
  }

  function renderAttachmentPreviewList(attachments = [], container, options = {}) {
    if (!container) return;
    container.replaceChildren();
    const items = Array.isArray(attachments) ? attachments : [];
    container.hidden = items.length === 0;
    for (const attachment of items) {
      const isImage = attachment.kind === 'image' && attachment.previewDataUrl;
      const label = attachment.name || (options.tx ? options.tx('Attachment', '附件') : 'Attachment');
      const card = document.createElement('div');
      card.className = 'codex-attachment-preview-card';
      card.dataset.kind = isImage ? 'image' : 'file';
      card.title = label + ' · ' + formatFileSize(attachment.size);
      if (isImage) {
        const preview = document.createElement('button');
        preview.type = 'button';
        preview.className = 'codex-attachment-preview-open';
        preview.setAttribute('aria-label', options.tx ? options.tx('Preview ' + label, '预览 ' + label) : 'Preview ' + label);
        preview.addEventListener('click', () => showAttachmentPreviewDialog(attachment, options));
        const image = document.createElement('img');
        image.src = attachment.previewDataUrl;
        image.alt = label;
        preview.append(image);
        card.append(preview);
      } else {
        const icon = document.createElement('span');
        icon.className = 'codex-attachment-file-icon';
        icon.textContent = getAttachmentIconLabel(attachment);
        icon.setAttribute('aria-hidden', 'true');
        card.append(icon);
      }
      const meta = document.createElement('span');
      meta.className = 'codex-attachment-preview-meta';
      const name = document.createElement('span');
      name.className = 'codex-attachment-preview-name';
      name.textContent = label;
      meta.append(name);
      if (!isImage) {
        const size = document.createElement('span');
        size.className = 'codex-attachment-preview-size';
        size.textContent = formatFileSize(attachment.size);
        meta.append(size);
      }
      card.append(meta);
      if (options.removable) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'codex-attachment-preview-remove';
        remove.textContent = '×';
        const removeLabel = options.tx ? options.tx('Remove ' + label, '移除 ' + label) : 'Remove ' + label;
        remove.title = removeLabel;
        remove.setAttribute('aria-label', removeLabel);
        remove.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          options.onRemove?.(attachment.id);
        });
        card.append(remove);
      }
      container.append(card);
    }
  }

  function showAttachmentPreviewDialog(attachment, options = {}) {
    if (!attachment?.previewDataUrl) {
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'codex-attachment-preview-dialog';
    overlay.setAttribute('data-attachment-preview-dialog', 'true');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', attachment.name || (options.tx ? options.tx('Attachment preview', '附件预览') : 'Attachment preview'));

    const card = document.createElement('section');
    card.className = 'codex-attachment-preview-dialog-card';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'codex-attachment-preview-dialog-close';
    close.textContent = '×';
    close.title = options.tr ? options.tr('close') : 'Close';
    close.setAttribute('aria-label', options.tr ? options.tr('close') : 'Close');
    const image = document.createElement('img');
    image.src = attachment.previewDataUrl;
    image.alt = attachment.name || (options.tx ? options.tx('Attached image', '已附加图片') : 'Attached image');
    const caption = document.createElement('div');
    caption.className = 'codex-attachment-preview-dialog-caption';
    caption.textContent = attachment.name || '';
    card.append(close, image, caption);
    overlay.append(card);

    const cleanup = () => {
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
    };
    const onKeydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cleanup();
      }
    };
    overlay.addEventListener('click', event => {
      if (event.target === overlay) {
        cleanup();
      }
    });
    close.addEventListener('click', cleanup);
    document.addEventListener('keydown', onKeydown, true);
    (options.root || document.body).append(overlay);
    close.focus();
  }

  function getAttachmentIconLabel(attachment = {}) {
    const name = String(attachment.name || '');
    const extension = name.includes('.') ? name.split('.').pop().slice(0, 4).toUpperCase() : '';
    if (/pdf/i.test(attachment.mimeType || '') || /\.pdf$/i.test(name)) {
      return 'PDF';
    }
    return extension || 'FILE';
  }

  function formatFileSize(size) {
    const bytes = Number(size) || 0;
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
    }
    if (bytes >= 1024) {
      return `${Math.round(bytes / 1024)} KB`;
    }
    return `${bytes} B`;
  }

  function isImageAttachment(attachment = {}) {
    return /^image\//i.test(String(attachment.mimeType || '')) ||
      /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(String(attachment.name || ''));
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(String(reader.result || ''));
      };
      reader.onerror = () => reject(reader.error || new Error('Could not read selected file'));
      reader.readAsDataURL(file);
    });
  }

  function extractBase64FromDataUrl(value) {
    const text = String(value || '');
    return text.includes(',') ? text.slice(text.indexOf(',') + 1) : text;
  }

  global.CodexOverleafComposerAttachments = {
    createComposerAttachmentController,
    _private: {
      collectFilesFromDataTransfer,
      normalizeAttachmentName,
      buildAttachmentDedupeKey,
      renderAttachmentPreviewList
    }
  };
})(window);
