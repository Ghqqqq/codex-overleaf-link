(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafGlobalPreferences = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'codexOverleafGlobalPrefsV1';
  const LEGACY_KEY = 'codexOverleafPrefs';
  const READ_MESSAGE = 'codex-overleaf/global-preferences/read';
  const PATCH_MESSAGE = 'codex-overleaf/global-preferences/patch';
  const DEFAULTS = Object.freeze({ theme: 'dark', locale: 'en', preloadProjectContext: true,
    loadCodexLocalSkills: true, loadCodexOverleafSkills: true });
  const FIELDS = Object.freeze([...Object.keys(DEFAULTS), 'codexOverleafSkillEnabled']);

  function validSkillId(id) {
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(id)
      && !['__proto__', 'prototype', 'constructor'].includes(id) && !id.includes('..');
  }

  function pick(value = {}) {
    const skills = {};
    for (const [id, enabled] of Object.entries(value.codexOverleafSkillEnabled || {}).slice(0, 200)) {
      if (validSkillId(id) && typeof enabled === 'boolean') skills[id] = enabled;
    }
    return {
      theme: ['dark', 'light', 'auto'].includes(value.theme) ? value.theme : 'dark',
      locale: value.locale === 'zh' ? 'zh' : 'en',
      preloadProjectContext: value.preloadProjectContext !== false,
      loadCodexLocalSkills: value.loadCodexLocalSkills !== false,
      loadCodexOverleafSkills: value.loadCodexOverleafSkills !== false,
      codexOverleafSkillEnabled: skills
    };
  }

  function validatePatch(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid global preference patch.');
    const patch = {};
    for (const [key, item] of Object.entries(value)) {
      if (!FIELDS.includes(key)) throw new Error('Unknown global preference: ' + key);
      if (key === 'theme' && !['dark', 'light', 'auto'].includes(item)
        || key === 'locale' && !['en', 'zh'].includes(item)
        || typeof DEFAULTS[key] === 'boolean' && typeof item !== 'boolean') {
        throw new Error('Invalid global preference: ' + key);
      }
      if (key === 'codexOverleafSkillEnabled') {
        if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length > 200) {
          throw new Error('Invalid skill preference map.');
        }
        for (const [id, enabled] of Object.entries(item)) {
          if (!validSkillId(id) || typeof enabled !== 'boolean') throw new Error('Invalid skill preference.');
        }
        patch[key] = { ...item };
      } else patch[key] = item;
    }
    return patch;
  }

  function applyPatch(values, patch) {
    return { ...pick(values), ...patch, codexOverleafSkillEnabled: {
      ...pick(values).codexOverleafSkillEnabled, ...(patch.codexOverleafSkillEnabled || {})
    } };
  }

  function changedKeys(left, right) {
    return FIELDS.filter(key => JSON.stringify(left[key]) !== JSON.stringify(right[key]));
  }

  function validateSnapshot(value) {
    if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1) {
      throw new Error('Invalid global preference revision.');
    }
    validatePatch(value.values);
    if (!FIELDS.every(key => Object.hasOwn(value.values, key))) throw new Error('Incomplete global preferences.');
    return { schemaVersion: 1, revision: value.revision, values: pick(value.values) };
  }

  function createStore(storage) {
    let tail = Promise.resolve();
    function serial(work) {
      const pending = tail.then(work);
      tail = pending.catch(() => {});
      return pending;
    }
    async function read() {
      const stored = await storage.get([STORAGE_KEY, LEGACY_KEY]);
      if (stored[STORAGE_KEY] !== undefined) return validateSnapshot(stored[STORAGE_KEY]);
      const snapshot = { schemaVersion: 1, revision: 1, values: pick(stored[LEGACY_KEY] || {}) };
      await storage.set({ [STORAGE_KEY]: snapshot });
      return snapshot;
    }
    return Object.freeze({
      read: () => serial(read),
      patch: input => serial(async () => {
        const patch = validatePatch(input);
        const previous = await read();
        const values = applyPatch(previous.values, patch);
        if (Object.keys(values.codexOverleafSkillEnabled).length > 200) throw new Error('Too many skill preferences.');
        if (!changedKeys(previous.values, values).length) return previous;
        const snapshot = { schemaVersion: 1, revision: previous.revision + 1, values };
        await storage.set({ [STORAGE_KEY]: snapshot });
        return snapshot;
      })
    });
  }

  function installBackground(chromeApi) {
    const store = createStore(chromeApi.storage?.local);
    chromeApi.runtime.onMessage.addListener((message, sender, respond) => {
      if (![READ_MESSAGE, PATCH_MESSAGE].includes(message?.type)) return undefined;
      let allowed = false;
      try {
        const url = new URL(sender?.tab?.url || '');
        allowed = sender.id === chromeApi.runtime.id && url.protocol === 'https:'
          && ['overleaf.com', 'www.overleaf.com'].includes(url.hostname)
          && /^\/project(?:\/|$)/.test(url.pathname);
      } catch (_error) { /* reject unrelated contexts */ }
      if (!allowed) {
        respond({ ok: false, error: { message: 'Global preferences require an Overleaf tab.' } });
        return false;
      }
      const pending = message.type === READ_MESSAGE ? store.read() : store.patch(message.patch);
      pending.then(result => respond({ ok: true, result }), error => respond({ ok: false, error: { message: error.message } }));
      return true;
    });
    return store;
  }

  return Object.freeze({ STORAGE_KEY, LEGACY_KEY, READ_MESSAGE, PATCH_MESSAGE, FIELDS,
    pick, validatePatch, validateSnapshot, applyPatch, changedKeys, createStore, installBackground });
});
