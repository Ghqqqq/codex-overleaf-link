'use strict';

const path = require('node:path');
const { splitTomlStatements, readTomlStatementPath } = require('./tomlStatements');

// These fields are paths resolved against the defining configuration layer by
// Codex. Moving that layer into an execution scope must preserve its old anchor.
const ROOT_PATHS = new Set(['sqlite_home', 'log_dir', 'model_catalog_json', 'model_instructions_file', 'experimental_compact_prompt_file']);
const PROFILE_PATHS = new Set(['model_catalog_json', 'model_instructions_file', 'experimental_compact_prompt_file']);
const TLS_PATHS = new Set(['ca-certificate', 'client-certificate', 'client-private-key']);

function isConfigPath(keys) {
  if (keys.length === 1 && ROOT_PATHS.has(keys[0])) return true;
  if (keys.length === 3 && keys[0] === 'profiles' && PROFILE_PATHS.has(keys[2])) return true;
  if (keys.length === 3 && keys[0] === 'agents' && keys[2] === 'config_file') return true;
  if (keys.length === 3 && keys[0] === 'skills' && keys[1] === 'config' && keys[2] === 'path') return true;
  if (keys.length === 2 && keys[0] === 'sandbox_workspace_write' && keys[1] === 'writable_roots') return true;
  if (keys.length === 4 && keys[0] === 'model_providers' && keys[2] === 'auth' && keys[3] === 'cwd') return true;
  return keys[0] === 'otel' && keys.includes('tls') && TLS_PATHS.has(keys.at(-1));
}

function rebaseCodexConfigPaths(content, originalDirectory) {
  let section = [];
  return splitTomlStatements(content).map(statement => {
    const parsed = readTomlStatementPath(statement);
    if (!parsed) return statement;
    if (parsed.table) { section = parsed.keys; return statement; }
    const edits = [];
    visitValue(statement, parsed.valueStart, [...section, ...parsed.keys], edits, originalDirectory);
    for (const edit of edits.reverse()) statement = statement.slice(0, edit.start) + edit.text + statement.slice(edit.end);
    return statement;
  }).join('');
}

function skipTrivia(text, position) {
  while (position < text.length) {
    if (/\s/.test(text[position])) { position++; continue; }
    if (text[position] !== '#') break;
    while (position < text.length && text[position] !== '\n') position++;
  }
  return position;
}

function visitValue(text, start, keys, edits, directory) {
  start = skipTrivia(text, start);
  if (text[start] === '"' || text[start] === "'") {
    const value = readString(text, start);
    if (isConfigPath(keys) && !path.isAbsolute(value.value) && !/^~(?:[/\\]|$)/.test(value.value) && !/^[a-z][a-z\d+.-]*:\/\//i.test(value.value)) {
      edits.push({ start, end: value.end, text: JSON.stringify(path.resolve(directory, value.value)) });
    }
    return value.end;
  }
  if (text[start] === '[' || text[start] === '{') {
    const table = text[start] === '{', end = table ? '}' : ']';
    let cursor = start + 1;
    while ((cursor = skipTrivia(text, cursor)) < text.length && text[cursor] !== end) {
      let childKeys = keys;
      if (table) {
        const key = readTomlStatementPath(text.slice(cursor));
        if (!key || key.table) throw new Error('Codex configuration contains an invalid inline TOML key.');
        childKeys = [...keys, ...key.keys]; cursor += key.valueStart;
      }
      const next = visitValue(text, cursor, childKeys, edits, directory);
      if (next <= cursor) break;
      cursor = skipTrivia(text, next);
      if (text[cursor] === ',') cursor++;
    }
    return cursor + 1;
  }
  let end = start;
  while (end < text.length && ![',', ']', '}', '#', '\n'].includes(text[end])) end++;
  return end;
}

function readString(text, start) {
  const quote = text[start], triple = text.slice(start, start + 3) === quote.repeat(3);
  let cursor = start + (triple ? 3 : 1), raw = '';
  if (triple && text[cursor] === '\n') cursor++;
  while (cursor < text.length) {
    if (text[cursor] === quote && (!triple || text.slice(cursor, cursor + 3) === quote.repeat(3))) {
      let count = triple ? 3 : 1;
      if (triple) while (count < 5 && text[cursor + count] === quote) count++;
      raw += triple ? quote.repeat(count - 3) : '';
      return { value: raw, end: cursor + count };
    }
    const char = text[cursor++];
    if (quote !== '"' || char !== '\\') { raw += char; continue; }
    const escaped = text[cursor++];
    if (triple && /\s/.test(escaped)) {
      while (/\s/.test(text[cursor] || '') && cursor < text.length) cursor++;
      continue;
    }
    const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (Object.prototype.hasOwnProperty.call(simple, escaped)) { raw += simple[escaped]; continue; }
    const count = escaped === 'u' ? 4 : escaped === 'U' ? 8 : 0;
    const hex = text.slice(cursor, cursor + count);
    const point = Number.parseInt(hex, 16);
    if (!count || !/^[\da-f]+$/i.test(hex) || hex.length !== count || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
      throw new Error('Codex configuration contains an invalid TOML string escape.');
    }
    raw += String.fromCodePoint(point); cursor += count;
  }
  throw new Error('Codex configuration contains an unterminated TOML string.');
}

module.exports = { rebaseCodexConfigPaths };
