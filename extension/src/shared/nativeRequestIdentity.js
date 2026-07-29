(function initNativeRequestIdentity(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CodexOverleafNativeRequestIdentity = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createNativeRequestIdentity() {
  "use strict";

  const MAX_REQUEST_ID_CHARS = 160;

  function invalidIdentity(value) {
    return {
      ok: false,
      error: {
        code: "native_request_id_invalid",
        message:
          `Native request id must be a finite number or a non-empty string no longer than ${MAX_REQUEST_ID_CHARS} characters.`,
        details: {
          actualType: value === null ? "null" : typeof value,
          actualLength: typeof value === "string" ? value.length : null,
          limit: MAX_REQUEST_ID_CHARS
        }
      }
    };
  }

  function validate(value) {
    if (typeof value === "number") {
      return Number.isFinite(value) ? { ok: true, id: value } : invalidIdentity(value);
    }
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_REQUEST_ID_CHARS) {
      return invalidIdentity(value);
    }
    return { ok: true, id: value };
  }

  function resolve(value, randomUUID) {
    if (value === undefined || value === null || value === "") {
      const generate =
        typeof randomUUID === "function"
          ? randomUUID
          : typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? () => crypto.randomUUID()
            : null;
      if (!generate) {
        return invalidIdentity(value);
      }
      return validate(generate());
    }
    return validate(value);
  }

  return Object.freeze({
    MAX_REQUEST_ID_CHARS,
    resolve
  });
});
