'use strict';

const { REFERENCE_LIMITS } = require('../../extension/src/shared/writingStyle');
const WRITING_STYLE_ATTACHMENT_QUOTAS = Object.freeze({
  maxAttachmentCount: REFERENCE_LIMITS.maxSources,
  maxAttachmentBytes: REFERENCE_LIMITS.maxPdfBytes,
  maxAttachmentTotalBytes: REFERENCE_LIMITS.maxAttachmentTotalBytes
});

const NATIVE_REQUEST_QUOTAS = Object.freeze({
  maxProjectFiles: 1000,
  maxProjectTextBytes: 32 * 1024 * 1024,
  maxProjectBinaryBytes: 32 * 1024 * 1024,
  maxOperations: 1000,
  maxCompileLogBytes: 512 * 1024,
  maxAttachmentCount: 8,
  maxAttachmentBytes: 12 * 1024 * 1024,
  maxAttachmentTotalBytes: 8 * 12 * 1024 * 1024,
  maxSkillContentBytes: 64 * 1024
});

function validateNativeRequestQuotas(request = {}) {
  const params = request.params || {};
  switch (request.method) {
    case 'codex.run':
      return firstQuotaViolation([
        validateProjectSnapshotQuota(params.project),
        validateOperationListQuota(params.fileOverlays, 'fileOverlays'),
        validateFilePayloadQuota(params.fileOverlays, 'fileOverlays'),
        validateCompileLogQuota(params),
        validateAttachmentQuota(params.attachments, params.writingStyleBuild ? WRITING_STYLE_ATTACHMENT_QUOTAS : NATIVE_REQUEST_QUOTAS),
        validateSkillContentQuota(params.skillContent)
      ]);
    case 'mirror.sync':
      return validateProjectSnapshotQuota(params.project);
    case 'mirror.confirmWriteback':
      return validateOperationListQuota(params.paths, 'paths');
    case 'mirror.patchFiles':
      return firstQuotaViolation([
        validateOperationListQuota(params.files, 'files'),
        validatePatchFileTextQuota(params.files)
      ]);
    case 'task.run':
      return firstQuotaViolation([
        validateProjectSnapshotQuota(params.project),
        validateOperationListQuota(params.fileOverlays, 'fileOverlays'),
        validateFilePayloadQuota(params.fileOverlays, 'fileOverlays'),
        validateOperationListQuota(params.proposedOperations, 'proposedOperations'),
        validateOperationPayloadQuota(params.proposedOperations, 'proposedOperations'),
        validateOperationListQuota(params.operations, 'operations'),
        validateOperationPayloadQuota(params.operations, 'operations'),
        validateCompileLogQuota(params)
      ]);
    case 'skills.install':
      return validateSkillContentQuota(params.content);
    default:
      return null;
  }
}

function firstQuotaViolation(violations) {
  return violations.find(Boolean) || null;
}

function validateProjectSnapshotQuota(project = {}) {
  const files = Array.isArray(project?.files) ? project.files : [];
  if (files.length > NATIVE_REQUEST_QUOTAS.maxProjectFiles) {
    return quotaViolation('project.files', NATIVE_REQUEST_QUOTAS.maxProjectFiles, files.length, 'too many project files');
  }

  return validateFilePayloadQuota(files, 'project.files');
}

function validateFilePayloadQuota(files, fieldPrefix) {
  let textBytes = 0;
  let binaryBytes = 0;
  for (const file of Array.isArray(files) ? files : []) {
    for (const key of ['content', 'nextContent']) {
      if (typeof file?.[key] === 'string') {
        textBytes += Buffer.byteLength(file[key], 'utf8');
      }
    }
    if (typeof file?.contentBase64 === 'string') {
      binaryBytes += getDeclaredOrEstimatedBinaryBytes(file);
    }
  }
  if (textBytes > NATIVE_REQUEST_QUOTAS.maxProjectTextBytes) {
    return quotaViolation(
      `${fieldPrefix}.content`,
      NATIVE_REQUEST_QUOTAS.maxProjectTextBytes,
      textBytes,
      `${fieldPrefix} text is too large`
    );
  }
  if (binaryBytes > NATIVE_REQUEST_QUOTAS.maxProjectBinaryBytes) {
    return quotaViolation(
      `${fieldPrefix}.contentBase64`,
      NATIVE_REQUEST_QUOTAS.maxProjectBinaryBytes,
      binaryBytes,
      `${fieldPrefix} binary payload is too large`
    );
  }
  return null;
}

function validatePatchFileTextQuota(files) {
  let textBytes = 0;
  for (const file of Array.isArray(files) ? files : []) {
    for (const key of ['nextContent', 'content']) {
      if (typeof file?.[key] === 'string') {
        textBytes += Buffer.byteLength(file[key], 'utf8');
      }
    }
  }
  return textBytes > NATIVE_REQUEST_QUOTAS.maxProjectTextBytes
    ? quotaViolation('files.content', NATIVE_REQUEST_QUOTAS.maxProjectTextBytes, textBytes, 'patch text is too large')
    : null;
}

function validateOperationListQuota(value, field) {
  const operations = Array.isArray(value) ? value : [];
  return operations.length > NATIVE_REQUEST_QUOTAS.maxOperations
    ? quotaViolation(field, NATIVE_REQUEST_QUOTAS.maxOperations, operations.length, 'too many operations')
    : null;
}

function validateOperationPayloadQuota(value, fieldPrefix) {
  const operations = Array.isArray(value) ? value : [];
  const { textBytes, binaryBytes } = measureOperationPayloads(operations);
  if (textBytes > NATIVE_REQUEST_QUOTAS.maxProjectTextBytes) {
    return quotaViolation(
      `${fieldPrefix}.content`,
      NATIVE_REQUEST_QUOTAS.maxProjectTextBytes,
      textBytes,
      `${fieldPrefix} text payload is too large`
    );
  }
  if (binaryBytes > NATIVE_REQUEST_QUOTAS.maxProjectBinaryBytes) {
    return quotaViolation(
      `${fieldPrefix}.contentBase64`,
      NATIVE_REQUEST_QUOTAS.maxProjectBinaryBytes,
      binaryBytes,
      `${fieldPrefix} binary payload is too large`
    );
  }
  return null;
}

function measureOperationPayloads(operations = []) {
  const totals = { textBytes: 0, binaryBytes: 0 };
  const seen = new Set();
  for (const operation of operations) {
    measureOperationPayloadValue(operation, '', totals, seen);
  }
  return totals;
}

function measureOperationPayloadValue(value, key, totals, seen) {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    if (isBase64PayloadKey(key)) {
      return;
    }
    totals.textBytes += Buffer.byteLength(value, 'utf8');
    return;
  }
  if (typeof value !== 'object') {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (typeof value.contentBase64 === 'string') {
    totals.binaryBytes += getDeclaredOrEstimatedBinaryBytes(value);
  } else if (isBinarySizedOperationPayload(value)) {
    totals.binaryBytes += Number(value.size);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      measureOperationPayloadValue(item, '', totals, seen);
    }
    return;
  }

  for (const [childKey, childValue] of Object.entries(value)) {
    if (isBase64PayloadKey(childKey)) {
      continue;
    }
    measureOperationPayloadValue(childValue, childKey, totals, seen);
  }
}

function isBase64PayloadKey(key) {
  return key === 'contentBase64';
}

function isBinarySizedOperationPayload(value = {}) {
  const size = Number(value.size);
  if (!Number.isFinite(size) || size <= 0) {
    return false;
  }
  return String(value.type || '').includes('binary')
    || String(value.kind || '') === 'binary'
    || Object.prototype.hasOwnProperty.call(value, 'contentBase64');
}

function validateCompileLogQuota(params = {}) {
  const bytes = Buffer.byteLength(String(params.compileLog || ''), 'utf8')
    + byteLengthOfStringArray(params.compileErrors)
    + byteLengthOfStringArray(params.compileWarnings);
  return bytes > NATIVE_REQUEST_QUOTAS.maxCompileLogBytes
    ? quotaViolation('compileLog', NATIVE_REQUEST_QUOTAS.maxCompileLogBytes, bytes, 'compile log context is too large')
    : null;
}

function validateAttachmentQuota(attachments, quotas = NATIVE_REQUEST_QUOTAS) {
  const items = Array.isArray(attachments) ? attachments : [];
  if (items.length > quotas.maxAttachmentCount) {
    return quotaViolation('attachments', quotas.maxAttachmentCount, items.length, 'too many attachments');
  }

  let totalBytes = 0;
  for (const item of items) {
    const bytes = getDeclaredOrEstimatedBinaryBytes(item);
    if (bytes > quotas.maxAttachmentBytes) {
      return quotaViolation(
        'attachments.contentBase64',
        quotas.maxAttachmentBytes,
        bytes,
        'attachment payload is too large'
      );
    }
    totalBytes += bytes;
  }
  return totalBytes > quotas.maxAttachmentTotalBytes
    ? quotaViolation('attachments', quotas.maxAttachmentTotalBytes, totalBytes, 'attachment payload is too large')
    : null;
}

function validateSkillContentQuota(content) {
  if (content === undefined || content === null) {
    return null;
  }
  const bytes = typeof content === 'string'
    ? Buffer.byteLength(content, 'utf8')
    : Buffer.byteLength(String(content), 'utf8');
  return bytes > NATIVE_REQUEST_QUOTAS.maxSkillContentBytes
    ? quotaViolation('content', NATIVE_REQUEST_QUOTAS.maxSkillContentBytes, bytes, 'skill content is too large')
    : null;
}

function getDeclaredOrEstimatedBinaryBytes(value = {}) {
  const declared = Number(value.size);
  const estimated = typeof value.contentBase64 === 'string'
    ? estimateBase64DecodedBytes(value.contentBase64)
    : 0;
  return Math.max(Number.isFinite(declared) && declared > 0 ? declared : 0, estimated);
}

function estimateBase64DecodedBytes(value) {
  const clean = String(value || '').replace(/\s+/g, '');
  if (!clean) {
    return 0;
  }
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(clean.length * 3 / 4) - padding);
}

function byteLengthOfStringArray(value) {
  return (Array.isArray(value) ? value : [])
    .reduce((sum, item) => sum + Buffer.byteLength(String(item || ''), 'utf8'), 0);
}

function quotaViolation(field, limit, actual, reason) {
  return {
    field,
    limit,
    actual,
    reason
  };
}

module.exports = {
  NATIVE_REQUEST_QUOTAS,
  estimateBase64DecodedBytes,
  firstQuotaViolation,
  measureOperationPayloads,
  quotaViolation,
  validateAttachmentQuota,
  validateCompileLogQuota,
  validateFilePayloadQuota,
  validateNativeRequestQuotas,
  validateOperationListQuota,
  validateOperationPayloadQuota,
  validatePatchFileTextQuota,
  validateProjectSnapshotQuota,
  validateSkillContentQuota
};
