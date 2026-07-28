(function initUpdateRevocationIntent(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CodexOverleafUpdateRevocation = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createUpdateRevocationIntent() {
  "use strict";

  function safeString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function safeTime(value, fallback = 0) {
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  function begin(consentState, updateState, now = Date.now()) {
    const consent = consentState && typeof consentState === "object" ? consentState : {};
    const update = updateState && typeof updateState === "object" ? updateState : {};
    return {
      ...consent,
      revokingAuthorizationId: safeString(consent.authorizationId),
      revokingVersion:
        safeString(consent.authorizedVersion) || safeString(update.latestVersion),
      revokingTransactionId: safeString(update.transactionId),
      revokingAt: safeTime(now)
    };
  }

  function prepareAuthorization(consentState, authorizationId, targetVersion, now = Date.now()) {
    const consent = consentState && typeof consentState === "object" ? consentState : {};
    return {
      ...consent,
      revokingAuthorizationId: safeString(authorizationId),
      revokingVersion: safeString(targetVersion),
      revokingTransactionId: "",
      revokingAt: safeTime(now)
    };
  }

  function hasPending(consentState) {
    const consent = consentState && typeof consentState === "object" ? consentState : {};
    return Boolean(
      safeString(consent.revokingAuthorizationId) &&
        safeString(consent.revokingVersion)
    );
  }

  function clear(consentState) {
    const consent = consentState && typeof consentState === "object" ? consentState : {};
    return {
      ...consent,
      revokingAuthorizationId: "",
      revokingVersion: "",
      revokingTransactionId: "",
      revokingAt: 0
    };
  }

  function complete(updateState, consentState, options = {}) {
    const update = updateState && typeof updateState === "object" ? updateState : {};
    const consent = consentState && typeof consentState === "object" ? consentState : {};
    const now = safeTime(options.now, Date.now());
    const snoozeMs = safeTime(options.snoozeMs);
    const version =
      safeString(consent.revokingVersion) ||
      safeString(consent.authorizedVersion) ||
      safeString(update.latestVersion);
    return {
      updateState: {
        ...update,
        state: "update_available",
        transactionId: "",
        stagedPath: "",
        stagedAt: 0,
        applyingAt: 0,
        awaitingHealthAt: 0,
        blocker: "",
        blockers: [],
        blockingReason: "",
        code: "",
        message: "",
        error: null,
        postponeUntil: safeTime(options.postponeUntil),
        postponeGuardVersion: version
      },
      consentState: clear({
        ...consent,
        mode: "snoozed",
        snoozedVersion: version,
        snoozedUntil: now + snoozeMs,
        authorizedVersion: "",
        authorizationId: "",
        authorizedAt: 0
      })
    };
  }

  return Object.freeze({
    begin,
    prepareAuthorization,
    hasPending,
    clear,
    complete
  });
});
