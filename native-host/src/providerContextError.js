'use strict';

// Provider and CLI representations of the same recoverable condition.
// Authentication, transport and output-budget errors keep their own handling.
function isContextLimitError(value, depth = 0) {
  if (depth > 3 || value == null) return false;
  if (typeof value === 'object') {
    return [value.code, value.codexErrorInfo, value.codex_error_info, value.error, value.message]
      .some(part => isContextLimitError(part, depth + 1));
  }
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (['contextlengthexceeded', 'contextwindowexceeded', 'modelcontextwindowexceeded', 'codexcontextlimit']
    .includes(text.replace(/[_-]/g, '').toLowerCase())) return true;
  return /Codex ran out of room in the model['’]s context window/i.test(text)
    || /maximum context length is\s+\d+\s+tokens[\s\S]*?requested\s+\d+\s+tokens/i.test(text)
    || /(?:context (?:length|window|limit) (?:has been |is )?exceeded|exceeds? (?:the |this model['’]s )?(?:maximum )?context (?:length|window|limit))/i.test(text);
}

module.exports = { isContextLimitError };
