(function initCodexOverleafOtText(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafOtText = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function otTextFactory() {
  'use strict';

  const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function applyTextOps(text, ops) {
    if (!Array.isArray(ops)) {
      return {
        ok: false,
        reason: 'invalid_ops'
      };
    }

    let next = normalizeText(text);
    for (const rawOp of ops) {
      const validated = validateTextOp(rawOp, next);
      if (!validated.ok) {
        return validated;
      }

      const op = validated.op;
      if (Object.prototype.hasOwnProperty.call(op, 'i')) {
        next = next.slice(0, op.p) + op.i + next.slice(op.p);
      } else {
        next = next.slice(0, op.p) + next.slice(op.p + op.d.length);
      }
    }

    return {
      ok: true,
      text: next
    };
  }

  function validateTextOp(rawOp, text) {
    if (!rawOp || typeof rawOp !== 'object' || Array.isArray(rawOp)) {
      return {
        ok: false,
        reason: 'invalid_op'
      };
    }

    const keys = Object.keys(rawOp);
    if (keys.some(key => key !== 'p' && key !== 'i' && key !== 'd')) {
      return {
        ok: false,
        reason: 'unknown_field'
      };
    }

    const hasInsert = Object.prototype.hasOwnProperty.call(rawOp, 'i');
    const hasDelete = Object.prototype.hasOwnProperty.call(rawOp, 'd');
    if (keys.length !== 2 || !Object.prototype.hasOwnProperty.call(rawOp, 'p') || hasInsert === hasDelete) {
      return {
        ok: false,
        reason: 'invalid_op'
      };
    }

    if (!Number.isInteger(rawOp.p) || rawOp.p < 0) {
      return {
        ok: false,
        reason: 'invalid_position'
      };
    }

    const hasText = typeof text !== 'undefined';
    const content = hasText ? normalizeText(text) : '';
    if (hasInsert) {
      if (typeof rawOp.i !== 'string') {
        return {
          ok: false,
          reason: 'invalid_op'
        };
      }
      if (rawOp.i.length === 0) {
        return {
          ok: false,
          reason: 'empty_text'
        };
      }
      if (hasText && rawOp.p > content.length) {
        return {
          ok: false,
          reason: 'invalid_position'
        };
      }
      return {
        ok: true,
        op: {
          p: rawOp.p,
          i: rawOp.i
        }
      };
    }

    if (typeof rawOp.d !== 'string') {
      return {
        ok: false,
        reason: 'invalid_op'
      };
    }
    if (rawOp.d.length === 0) {
      return {
        ok: false,
        reason: 'empty_text'
      };
    }
    if (hasText && rawOp.p + rawOp.d.length > content.length) {
      return {
        ok: false,
        reason: 'invalid_position'
      };
    }
    if (hasText && content.slice(rawOp.p, rawOp.p + rawOp.d.length) !== rawOp.d) {
      return {
        ok: false,
        reason: 'delete_mismatch',
        message: `Delete text did not match current content at position ${rawOp.p}.`
      };
    }

    return {
      ok: true,
      op: {
        p: rawOp.p,
        d: rawOp.d
      }
    };
  }

  function diffToTextOps(oldText, newText) {
    const previous = normalizeText(oldText);
    const next = normalizeText(newText);
    if (previous === next) {
      return [];
    }

    const sharedLength = Math.min(previous.length, next.length);
    let prefix = 0;
    while (prefix < sharedLength && previous[prefix] === next[prefix]) {
      prefix += 1;
    }

    let previousEnd = previous.length;
    let nextEnd = next.length;
    while (
      previousEnd > prefix &&
      nextEnd > prefix &&
      previous[previousEnd - 1] === next[nextEnd - 1]
    ) {
      previousEnd -= 1;
      nextEnd -= 1;
    }

    const deleted = previous.slice(prefix, previousEnd);
    const inserted = next.slice(prefix, nextEnd);
    const ops = [];
    if (deleted) {
      ops.push({
        p: prefix,
        d: deleted
      });
    }
    if (inserted) {
      ops.push({
        p: prefix,
        i: inserted
      });
    }
    return ops;
  }

  function normalizeObservedTextEvent(rawEvent) {
    const event = rawEvent && typeof rawEvent === 'object' ? rawEvent : {};
    const path = normalizePath(event.path);
    if (!path) {
      return {
        ok: false,
        reason: 'missing_path'
      };
    }

    const previousContent = normalizeText(event.previousContent);
    const nextContent = normalizeText(event.nextContent);
    const ops = Array.isArray(event.ops)
      ? normalizeTextOps(event.ops, previousContent)
      : {
          ok: true,
          ops: diffToTextOps(previousContent, nextContent)
        };
    if (!ops.ok) {
      return {
        ok: false,
        reason: ops.reason,
        path
      };
    }

    const applied = applyTextOps(previousContent, ops.ops);
    if (!applied.ok) {
      return {
        ok: false,
        reason: applied.reason,
        path
      };
    }
    if (applied.text !== nextContent) {
      return {
        ok: false,
        reason: 'ops_do_not_produce_next_content',
        path
      };
    }

    return {
      ok: true,
      path,
      previousContent,
      nextContent,
      observedAt: normalizeObservedAt(event.observedAt),
      observedVersion: normalizeObservedVersion(event.observedVersion),
      source: normalizeSource(event.source),
      baseHash: hashText(previousContent),
      nextHash: hashText(nextContent),
      ops: ops.ops
    };
  }

  function normalizeTextOps(rawOps, baseText) {
    const normalized = [];
    let current = normalizeText(baseText);
    for (const rawOp of rawOps) {
      const validated = validateTextOp(rawOp, current);
      if (!validated.ok) {
        return validated;
      }
      const op = validated.op;
      normalized.push(op);
      if (Object.prototype.hasOwnProperty.call(op, 'i')) {
        current = current.slice(0, op.p) + op.i + current.slice(op.p);
      } else {
        current = current.slice(0, op.p) + current.slice(op.p + op.d.length);
      }
    }
    return {
      ok: true,
      ops: normalized
    };
  }

  function hashText(text) {
    const value = String(text ?? '');
    return sha256Hex(utf8Bytes(value));
  }

  function normalizePath(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/\\/g, '/')
      .trim()
      .replace(/^\/+/, '');
  }

  function normalizeText(value) {
    return String(value ?? '');
  }

  function normalizeObservedAt(value) {
    if (value instanceof Date) {
      return validDateToIso(value) || new Date().toISOString();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return validDateToIso(new Date(value)) || new Date().toISOString();
    }
    const text = String(value || '').trim();
    return text || new Date().toISOString();
  }

  function validDateToIso(date) {
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  function normalizeObservedVersion(value) {
    if (value === null || typeof value === 'undefined' || value === '') {
      return null;
    }
    return String(value);
  }

  function normalizeSource(value) {
    if (value === null || typeof value === 'undefined') {
      return null;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      const source = String(value).trim();
      return source || null;
    }

    const normalized = {};
    for (const [key, sourceValue] of Object.entries(value)) {
      if (isContentSourceField(key) || sourceValue === null || typeof sourceValue === 'undefined') {
        continue;
      }
      if (typeof sourceValue === 'string' || typeof sourceValue === 'number' || typeof sourceValue === 'boolean') {
        normalized[key] = sourceValue;
      }
    }
    return Object.keys(normalized).length ? normalized : null;
  }

  function isContentSourceField(key) {
    return /^(content|previousContent|nextContent|text|body|raw|rawContent)$/i.test(key);
  }

  function utf8Bytes(text) {
    if (typeof TextEncoder === 'function') {
      return Array.from(new TextEncoder().encode(text));
    }
    if (typeof Buffer === 'function' && typeof Buffer.from === 'function') {
      return Array.from(Buffer.from(text, 'utf8'));
    }

    const bytes = [];
    for (let index = 0; index < text.length; index += 1) {
      let codePoint = text.charCodeAt(index);
      if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
        const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
          index += 1;
        } else {
          codePoint = 0xfffd;
        }
      } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
        codePoint = 0xfffd;
      }
      if (codePoint <= 0x7f) {
        bytes.push(codePoint);
      } else if (codePoint <= 0x7ff) {
        bytes.push(
          0xc0 | (codePoint >> 6),
          0x80 | (codePoint & 0x3f)
        );
      } else if (codePoint <= 0xffff) {
        bytes.push(
          0xe0 | (codePoint >> 12),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f)
        );
      } else {
        bytes.push(
          0xf0 | (codePoint >> 18),
          0x80 | ((codePoint >> 12) & 0x3f),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f)
        );
      }
    }
    return bytes;
  }

  function sha256Hex(inputBytes) {
    const bytes = inputBytes.slice();
    const bitLength = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) {
      bytes.push(0);
    }

    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    bytes.push(
      (high >>> 24) & 0xff,
      (high >>> 16) & 0xff,
      (high >>> 8) & 0xff,
      high & 0xff,
      (low >>> 24) & 0xff,
      (low >>> 16) & 0xff,
      (low >>> 8) & 0xff,
      low & 0xff
    );

    const hash = [
      0x6a09e667,
      0xbb67ae85,
      0x3c6ef372,
      0xa54ff53a,
      0x510e527f,
      0x9b05688c,
      0x1f83d9ab,
      0x5be0cd19
    ];
    const words = new Array(64);

    for (let chunk = 0; chunk < bytes.length; chunk += 64) {
      for (let index = 0; index < 16; index += 1) {
        const offset = chunk + index * 4;
        words[index] = (
          (bytes[offset] << 24) |
          (bytes[offset + 1] << 16) |
          (bytes[offset + 2] << 8) |
          bytes[offset + 3]
        ) >>> 0;
      }
      for (let index = 16; index < 64; index += 1) {
        const s0 = rotr(words[index - 15], 7) ^ rotr(words[index - 15], 18) ^ (words[index - 15] >>> 3);
        const s1 = rotr(words[index - 2], 17) ^ rotr(words[index - 2], 19) ^ (words[index - 2] >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
      }

      let a = hash[0];
      let b = hash[1];
      let c = hash[2];
      let d = hash[3];
      let e = hash[4];
      let f = hash[5];
      let g = hash[6];
      let h = hash[7];

      for (let index = 0; index < 64; index += 1) {
        const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + s1 + ch + SHA256_K[index] + words[index]) >>> 0;
        const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (s0 + maj) >>> 0;

        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }

      hash[0] = (hash[0] + a) >>> 0;
      hash[1] = (hash[1] + b) >>> 0;
      hash[2] = (hash[2] + c) >>> 0;
      hash[3] = (hash[3] + d) >>> 0;
      hash[4] = (hash[4] + e) >>> 0;
      hash[5] = (hash[5] + f) >>> 0;
      hash[6] = (hash[6] + g) >>> 0;
      hash[7] = (hash[7] + h) >>> 0;
    }

    return hash.map(word => word.toString(16).padStart(8, '0')).join('');
  }

  function rotr(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
  }

  return {
    applyTextOps,
    validateTextOp,
    diffToTextOps,
    normalizeObservedTextEvent,
    hashText
  };
});
