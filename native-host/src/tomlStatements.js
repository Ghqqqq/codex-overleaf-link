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

module.exports = { splitTomlStatements };
