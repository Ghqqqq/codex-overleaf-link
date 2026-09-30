'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { REFERENCE_LIMITS } = require('../extension/src/shared/writingStyle');
const { validateNativeRequestQuotas } = require('../native-host/src/nativeQuotas');
const MiB = 1024 * 1024;
const request = (sizes, writingStyleBuild) => ({ method: 'codex.run', params: {
  writingStyleBuild, attachments: sizes.map(size => ({ size, contentBase64: '' }))
} });

test('writing-style reference limits retain a bounded 20 MiB per-PDF / 40 MiB PDF total contract', () => {
  assert.equal(REFERENCE_LIMITS.maxPdfBytes, 20 * MiB);
  assert.equal(REFERENCE_LIMITS.maxPdfTotalBytes, 40 * MiB);
  assert.equal(REFERENCE_LIMITS.maxProjectBytes, 4 * MiB);
  assert.equal(REFERENCE_LIMITS.maxSources, 3);
  assert.equal(REFERENCE_LIMITS.pdfExtractionTimeoutMs, 90000);
});

test('native build quota accepts two largest PDFs and one project without changing ordinary chat limits', () => {
  assert.equal(validateNativeRequestQuotas(request([20 * MiB, 20 * MiB, 4 * MiB], {})), null);
  assert.ok(validateNativeRequestQuotas(request([20 * MiB], undefined)));
  assert.ok(validateNativeRequestQuotas(request([20 * MiB + 1], {})));
  assert.ok(validateNativeRequestQuotas(request([20 * MiB, 20 * MiB, 4 * MiB + 1], {})));
  assert.ok(validateNativeRequestQuotas(request([1, 1, 1, 1], {})));
});

test('maximum reference envelope leaves room below the browser message ceiling after base64 expansion', () => {
  const encodedBytes = 4 * Math.ceil(REFERENCE_LIMITS.maxAttachmentTotalBytes / 3);
  assert.ok(encodedBytes + 1024 * 1024 < 64 * MiB);
});
