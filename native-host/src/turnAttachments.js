'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { estimateBase64DecodedBytes } = require('./nativeTransportEnvelope');

const TURN_ATTACHMENTS_DIR = '.codex-overleaf-attachments';
const MAX_TURN_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_TURN_ATTACHMENTS = 8;
const MAX_TURN_ATTACHMENT_TOTAL_BYTES = MAX_TURN_ATTACHMENT_BYTES * MAX_TURN_ATTACHMENTS;

function materializeTurnAttachments(attachments = [], workspacePath = '') {
  if (!workspacePath) {
    return [];
  }
  const attachmentDir = path.join(workspacePath, TURN_ATTACHMENTS_DIR);
  fs.rmSync(attachmentDir, { recursive: true, force: true });

  const normalized = normalizeTurnAttachments(attachments);
  if (!normalized.length) {
    return [];
  }

  fs.mkdirSync(attachmentDir, { recursive: true });
  const usedNames = new Set();
  return normalized.map(attachment => {
    const fileName = dedupeAttachmentFileName(attachment.name, usedNames);
    const target = path.join(attachmentDir, fileName);
    const resolvedTarget = path.resolve(target);
    const resolvedDir = path.resolve(attachmentDir);
    if (!resolvedTarget.startsWith(resolvedDir + path.sep)) {
      throw new Error('Unsafe attachment path');
    }
    fs.writeFileSync(target, attachment.bytes);
    return {
      name: fileName,
      path: `${TURN_ATTACHMENTS_DIR}/${fileName}`,
      mimeType: attachment.mimeType,
      size: attachment.bytes.length
    };
  });
}

function normalizeTurnAttachments(value) {
  const input = Array.isArray(value) ? value : [];
  if (input.length > MAX_TURN_ATTACHMENTS) {
    throw new Error(`Too many attachments (${input.length}/${MAX_TURN_ATTACHMENTS})`);
  }
  const result = [];
  let totalBytes = 0;
  for (const item of input) {
    const name = sanitizeAttachmentFileName(item?.name);
    const contentBase64 = String(item?.contentBase64 || '').replace(/\s+/g, '');
    if (!name || !contentBase64) {
      continue;
    }
    const declared = Number(item?.size);
    const estimatedBytes = Math.max(
      Number.isFinite(declared) && declared > 0 ? declared : 0,
      estimateBase64DecodedBytes(contentBase64)
    );
    if (estimatedBytes > MAX_TURN_ATTACHMENT_BYTES) {
      throw new Error(`Attachment is too large: ${name}`);
    }
    const bytes = Buffer.from(contentBase64, 'base64');
    if (!bytes.length) {
      continue;
    }
    if (bytes.length > MAX_TURN_ATTACHMENT_BYTES) {
      throw new Error(`Attachment is too large: ${name}`);
    }
    totalBytes += Math.max(estimatedBytes, bytes.length);
    if (totalBytes > MAX_TURN_ATTACHMENT_TOTAL_BYTES) {
      throw new Error(`Attachments are too large (${totalBytes}/${MAX_TURN_ATTACHMENT_TOTAL_BYTES} bytes)`);
    }
    result.push({
      name,
      mimeType: String(item?.mimeType || '').trim().slice(0, 120),
      bytes
    });
  }
  return result;
}

function sanitizeAttachmentFileName(value) {
  const basename = String(value || '')
    .replace(/\0/g, '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop()
    ?.trim()
    .slice(0, 180) || '';
  return basename.replace(/[/:]/g, '-');
}

function dedupeAttachmentFileName(name, usedNames) {
  let candidate = name || 'attachment';
  if (!usedNames.has(candidate)) {
    usedNames.add(candidate);
    return candidate;
  }
  const parsed = path.parse(candidate);
  let index = 2;
  do {
    candidate = `${parsed.name}-${index}${parsed.ext}`;
    index += 1;
  } while (usedNames.has(candidate));
  usedNames.add(candidate);
  return candidate;
}

module.exports = { materializeTurnAttachments, normalizeTurnAttachments };
