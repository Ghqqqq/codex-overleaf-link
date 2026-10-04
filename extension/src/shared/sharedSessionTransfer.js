(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('SharedSessionTransfer', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';
  const MAX_WIRE_BYTES = 24 * 1024 * 1024;
  // The old UTF-16 estimate admitted up to 3 UTF-8 bytes per code unit.
  // Retain that finite Unicode window without enlarging ordinary ASCII writes.
  const MAX_RECORD_BYTES = MAX_WIRE_BYTES * 3 / 2;
  const MAX_RESPONSE_BYTES = MAX_RECORD_BYTES;
  const MAX_DECODED_BYTES = 2 * MAX_RECORD_BYTES + 64 * 1024;
  const error = (code, message) => Object.assign(new Error(message), { code });
  const tooLarge = () => error('shared_session_too_large', 'The session batch exceeds the bounded shared storage transfer limit.');
  const invalid = () => error('shared_session_transfer_invalid', 'The shared history transfer is invalid or incomplete.');
  const byteLength = text => new TextEncoder().encode(text).byteLength;

  function serialize(value, limit) {
    // Count a lower bound during serialization, before a large aggregate string
    // can be produced. The final UTF-8 check also includes commas and escaping.
    let lowerBound = 0;
    const text = JSON.stringify(value, function (key, item) {
      if (key && !Array.isArray(this)) lowerBound += byteLength(JSON.stringify(key)) + 1;
      if (typeof item === 'string') {
        if (item.length > limit) throw tooLarge();
        lowerBound += byteLength(JSON.stringify(item));
      } else if (item === null) lowerBound += 4;
      else if (typeof item === 'number') lowerBound += Number.isFinite(item) ? String(item).length : 4;
      else if (typeof item === 'boolean') lowerBound += String(item).length;
      else if (item && typeof item === 'object') lowerBound += 2;
      if (lowerBound > limit) throw tooLarge();
      return item;
    });
    if (typeof text !== 'string') throw invalid();
    const bytes = byteLength(text);
    if (bytes > limit) throw tooLarge();
    return { text, bytes };
  }

  function validateRecord(record) {
    const value = serialize(record, MAX_RECORD_BYTES);
    if (value.bytes > MAX_WIRE_BYTES && value.text.length * 2 > MAX_WIRE_BYTES) throw tooLarge();
  }

  function validateResponse(records) { serialize(records, MAX_RESPONSE_BYTES); }

  function validateEntries(entries) {
    if (!Array.isArray(entries)) throw invalid();
    for (const entry of entries) {
      if (!entry || !entry.record || typeof entry.record !== 'object' || Array.isArray(entry.record)) throw invalid();
      validateRecord(entry.record);
      if (entry.base != null) {
        if (typeof entry.base !== 'object' || Array.isArray(entry.base)) throw invalid();
        // A previously stored merged baseline may be larger than new records;
        // allow a bounded old base so a smaller candidate can repair it.
        serialize(entry.base, MAX_DECODED_BYTES);
      }
    }
  }

  async function readLimited(stream, limit) {
    const reader = stream.getReader(), chunks = [];
    let length = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        if (length > limit) { await reader.cancel().catch(() => {}); throw tooLarge(); }
        chunks.push(result.value);
      }
    } finally { reader.releaseLock(); }
    const output = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  }

  function toBase64(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  }
  function fromBase64(value) {
    if (typeof value !== 'string' || !value.length || value.length % 4
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalid();
    const text = atob(value);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  }

  async function encode(entries, environment = globalThis) {
    validateEntries(entries);
    const raw = serialize(entries, MAX_DECODED_BYTES);
    if (raw.bytes <= MAX_WIRE_BYTES || (raw.bytes <= MAX_RECORD_BYTES && raw.text.length * 2 <= MAX_WIRE_BYTES)) {
      return { method: 'put', payload: { entries } };
    }
    if (typeof environment.CompressionStream !== 'function') {
      throw error('shared_session_compression_unavailable',
        'Lossless transfer compression is unavailable. History remains in memory; retry with a supported browser.');
    }
    const input = new Blob([raw.text]).stream();
    const packed = await readLimited(input.pipeThrough(new environment.CompressionStream('gzip')),
      Math.floor((MAX_WIRE_BYTES - 1024) * 3 / 4));
    const payload = { encoding: 'gzip-base64', version: 1, decodedBytes: raw.bytes, data: toBase64(packed) };
    serialize(payload, MAX_WIRE_BYTES);
    // A distinct method makes an older worker reject rather than acknowledge
    // an absent `entries` array as a successful empty write.
    return { method: 'put-compressed', payload };
  }

  async function decode(message, environment = globalThis) {
    if (message.method !== 'put-compressed') {
      const entries = message.method === 'import' ? [{ record: message.record }] : message.entries || [];
      const raw = serialize(entries, MAX_RECORD_BYTES);
      if (raw.bytes > MAX_WIRE_BYTES && raw.text.length * 2 > MAX_WIRE_BYTES) throw tooLarge();
      validateEntries(entries); return entries;
    }
    const payload = { encoding: message.encoding, version: message.version, decodedBytes: message.decodedBytes, data: message.data };
    serialize(payload, MAX_WIRE_BYTES);
    if (message.entries != null || payload.encoding !== 'gzip-base64' || payload.version !== 1
      || !Number.isSafeInteger(payload.decodedBytes) || payload.decodedBytes < 1 || payload.decodedBytes > MAX_DECODED_BYTES) throw invalid();
    if (typeof environment.DecompressionStream !== 'function') throw error('shared_session_compression_unavailable',
      'Lossless transfer decompression is unavailable. Reload the extension and retry.');
    let bytes;
    try {
      bytes = await readLimited(new Blob([fromBase64(payload.data)]).stream()
        .pipeThrough(new environment.DecompressionStream('gzip')), MAX_DECODED_BYTES);
    } catch (failure) {
      if (['shared_session_too_large', 'shared_session_transfer_invalid'].includes(failure?.code)) throw failure;
      throw invalid();
    }
    if (bytes.byteLength !== payload.decodedBytes) throw invalid();
    let entries;
    try { entries = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch (_error) { throw invalid(); }
    validateEntries(entries);
    return entries;
  }
  return { MAX_WIRE_BYTES, MAX_RECORD_BYTES, MAX_RESPONSE_BYTES, MAX_DECODED_BYTES, byteLength, validateRecord, validateResponse, encode, decode };
});
