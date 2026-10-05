'use strict';

// Preserve TOML source text while finding complete logical statements. This is
// a lexical boundary scanner, not a TOML value/schema parser. Filters must never
// treat an apparent key or table header inside a multiline value as syntax.
function splitTomlStatements(content) {
  const text = String(content || '').replace(/\r\n/g, '\n');
  const statements = [];
  const containers = [];
  let start = 0;
  let quote = '';
  let multiline = false;
  let comment = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (comment) {
      if (char !== '\n') continue;
      comment = false;
    }
    if (quote) {
      if (quote === '"' && char === '\\') {
        // Basic strings escape the next character, including the first quote
        // of a potential delimiter. Literal strings have no escape syntax.
        index++;
      } else if (char === quote) {
        if (!multiline) {
          quote = '';
        } else if (text.slice(index, index + 3) === quote.repeat(3)) {
          // A legal closing delimiter can have one or two literal quotes just
          // before it: consume all four/five instead of opening another string.
          let count = 3;
          while (count < 5 && text[index + count] === quote) count++;
          index += count - 1;
          quote = '';
        }
      }
      continue;
    }
    if (char === '#') {
      comment = true;
    } else if (char === '"' || char === "'") {
      quote = char;
      multiline = text.slice(index, index + 3) === char.repeat(3);
      if (multiline) index += 2;
    } else if (char === '[' || char === '{') {
      containers.push(char);
    } else if (char === ']' || char === '}') {
      const opener = char === ']' ? '[' : '{';
      if (containers.pop() !== opener) throw incompleteValue();
    } else if (char === '\n' && containers.length === 0) {
      statements.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }

  // Do not silently remove the remaining config if a selected value is broken.
  // The caller prepares the full string before writing the destination file.
  if (quote || containers.length) throw incompleteValue();
  if (start < text.length) statements.push(text.slice(start));
  return statements;
}

function incompleteValue() {
  return new Error('Codex configuration contains an unterminated or mismatched TOML value.');
}

// Parse only a statement's key path, leaving its value and original formatting
// untouched. A quoted dot belongs to a key; an unquoted dot separates keys.
function readTomlStatementPath(statement) {
  const text = String(statement || '');
  let index = 0;
  const whitespace = () => { while (text[index] === ' ' || text[index] === '\t') index++; };
  whitespace();
  if (!text[index] || text[index] === '#' || text[index] === '\n') return null;
  const table = text[index] === '[';
  let brackets = 0;
  if (table) {
    brackets = text[index + 1] === '[' ? 2 : 1;
    index += brackets;
  }
  const keys = [];
  while (true) {
    whitespace();
    let key = '';
    const quote = text[index];
    if (quote === '"' || quote === "'") {
      index++;
      while (index < text.length && text[index] !== quote) {
        const char = text[index++];
        if (char === '\n' || char === '\r') throw invalidKey();
        if (quote !== '"' || char !== '\\') { key += char; continue; }
        const escape = text[index++];
        const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
        if (Object.prototype.hasOwnProperty.call(simple, escape)) { key += simple[escape]; continue; }
        const count = escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
        const hex = text.slice(index, index + count);
        if (!count || hex.length !== count || !/^[0-9a-f]+$/i.test(hex)) throw invalidKey();
        const point = Number.parseInt(hex, 16);
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw invalidKey();
        key += String.fromCodePoint(point);
        index += count;
      }
      if (text[index++] !== quote) throw invalidKey();
    } else {
      const match = text.slice(index).match(/^[A-Za-z0-9_-]+/);
      if (!match) return null;
      key = match[0]; index += key.length;
    }
    keys.push(key);
    whitespace();
    if (text[index] !== '.') break;
    index++;
  }
  if (table) {
    if (text.slice(index, index + brackets) !== ']'.repeat(brackets)) return null;
    index += brackets; whitespace();
    if (text[index] && text[index] !== '#' && text[index] !== '\n') return null;
  } else if (text[index] !== '=') return null;
  return { table, keys, ...(table ? {} : { valueStart: index + 1 }) };
}

function filterTomlRootKeys(content, excludedKeys) {
  const excluded = new Set(excludedKeys);
  const output = [];
  let section = [];
  for (const statement of splitTomlStatements(content)) {
    const parsed = readTomlStatementPath(statement);
    if (parsed?.table) section = parsed.keys;
    const root = section.length ? section[0] : parsed?.keys[0];
    if (!excluded.has(root)) output.push(statement);
  }
  return output.join('');
}

function invalidKey() {
  return new Error('Codex configuration contains an invalid TOML key.');
}

module.exports = { splitTomlStatements, filterTomlRootKeys, readTomlStatementPath };
