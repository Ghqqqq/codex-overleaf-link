'use strict';

const {
  MAX_NATIVE_OUTPUT_MESSAGE_BYTES,
  decodeFrames,
  encodeMessage
} = require('./nativeMessaging');
const nativeQuotas = require('./nativeQuotas');
const {
  enforceNativeOkResponseBudget,
  truncateUtf8Text
} = require('./nativeResponseBudget');

function decodeInputFrames(buffer) {
  return decodeFrames(buffer);
}

function encodeOutputFrame(response) {
  try {
    return encodeMessage(response);
  } catch (error) {
    const fallback = buildOversizeResponseFallback(response, error);
    try {
      return encodeMessage(fallback);
    } catch (fallbackError) {
      return encodeMessage(buildFinalOversizeError(response, fallbackError, error));
    }
  }
}

  function getRequestQuotaViolation(request) {
    if (typeof request?.id === "string" && request.id.length > 160) {
      return {
        field: "id",
        limit: 160,
        actual: request.id.length,
        reason: "request id is too large"
      };
    }
    return nativeQuotas.validateNativeRequestQuotas(request);
  }

function reduceTaskResult(result) {
  return enforceNativeOkResponseBudget(result);
}

function buildOversizeResponseFallback(response, error) {
  if (response?.event) {
    const event = response.event || {};
    return {
      id: boundedResponseId(response.id),
      ok: true,
      event: {
        type: event.type || 'native.event.truncated',
        title: truncateForNativeFrame(event.title || 'Native event was truncated', 500),
        status: event.status || 'warning',
        detail: {
          code: 'native_event_truncated',
          reason: truncateForNativeFrame(
            error?.message || 'Native event exceeded the browser frame limit.',
            800
          ),
          originalType: truncateForNativeFrame(event.type || '', 160),
          originalTitle: truncateForNativeFrame(event.title || '', 500),
          originalDetailBytes: measureJsonBytes(event.detail)
        },
        timestamp: event.timestamp || new Date().toISOString()
      }
    };
  }

  return {
    id: boundedResponseId(response?.id),
    ok: false,
    error: {
      code: 'native_response_too_large',
      message: truncateForNativeFrame(
        error?.message || 'Native response exceeded the browser frame limit.',
        800
      ),
      originalOk: response?.ok === true
    }
  };
}

function buildFinalOversizeError(response, fallbackError, originalError) {
  return {
    id: boundedResponseId(response?.id),
    ok: false,
    error: {
      code: 'native_response_too_large',
      message: truncateForNativeFrame(
        fallbackError?.message
          || originalError?.message
          || 'Native response exceeded the browser frame limit.',
        800
      )
    }
  };
}

function boundedResponseId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return truncateForNativeFrame(value, 160);
}

function measureJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (_error) {
    return 0;
  }
}

function truncateForNativeFrame(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 24))}... [truncated]`;
}

module.exports = {
  MAX_NATIVE_OUTPUT_MESSAGE_BYTES,
  NATIVE_REQUEST_QUOTAS: nativeQuotas.NATIVE_REQUEST_QUOTAS,
  buildOversizeResponseFallback,
  decodeInputFrames,
  encodeOutputFrame,
  estimateBase64DecodedBytes: nativeQuotas.estimateBase64DecodedBytes,
  firstQuotaViolation: nativeQuotas.firstQuotaViolation,
  getRequestQuotaViolation,
  measureJsonBytes,
  measureOperationPayloads: nativeQuotas.measureOperationPayloads,
  quotaViolation: nativeQuotas.quotaViolation,
  reduceTaskResult,
  truncateForNativeFrame,
  truncateUtf8Text,
  validateAttachmentQuota: nativeQuotas.validateAttachmentQuota,
  validateCompileLogQuota: nativeQuotas.validateCompileLogQuota,
  validateFilePayloadQuota: nativeQuotas.validateFilePayloadQuota,
  validateOperationListQuota: nativeQuotas.validateOperationListQuota,
  validateOperationPayloadQuota: nativeQuotas.validateOperationPayloadQuota,
  validatePatchFileTextQuota: nativeQuotas.validatePatchFileTextQuota,
  validateProjectSnapshotQuota: nativeQuotas.validateProjectSnapshotQuota,
  validateSkillContentQuota: nativeQuotas.validateSkillContentQuota
};
