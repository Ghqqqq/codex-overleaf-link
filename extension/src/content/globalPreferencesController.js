(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../shared/globalPreferences'));
  else root.CodexOverleafModuleRegistry.define('GlobalPreferencesController', ['GlobalPreferences'], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Preferences) {
  'use strict';

  const CONTROLS = Object.freeze({ theme: '[data-theme-select]', locale: '[data-language-select]',
    preloadProjectContext: '[data-preload-project-context]', loadCodexLocalSkills: '[data-load-codex-local-skills]',
    loadCodexOverleafSkills: '[data-load-codex-overleaf-skills]' });

  function create(options) {
    const chromeApi = options.chromeApi;
    const fallback = Preferences.pick(options.getState?.() || {});
    let snapshot = null;
    let loading = null;
    let subscribed = false;
    let disposed = false;
    let lastError = null;
    let tail = Promise.resolve();
    const pending = [];

    function view() {
      return pending.reduce((values, operation) => Preferences.applyPatch(values, operation.patch), snapshot?.values || fallback);
    }

    function render(force = false) {
      if (disposed) return;
      const previous = options.getState?.() || {};
      const values = view();
      const changed = Preferences.changedKeys(Preferences.pick(previous), values);
      options.setState?.({ ...previous, ...values });
      const panel = options.getPanel?.();
      if (!panel) return;
      for (const [field, selector] of Object.entries(CONTROLS)) {
        const control = panel.querySelector(selector);
        if (!control) continue;
        if (typeof values[field] === 'boolean') control.checked = values[field];
        else if (control.value !== values[field]) control.value = values[field];
      }
      if (force || changed.includes('theme')) options.applyTheme?.(values.theme);
      if (changed.includes('locale')) options.applyLocale?.();
      if (force || changed.includes('preloadProjectContext')) options.onPreloadChange?.(values.preloadProjectContext);
      if (changed.some(key => key === 'codexOverleafSkillEnabled' || key.startsWith('loadCodex'))) options.onSkillsChange?.();
    }

    function accept(value) {
      const next = Preferences.validateSnapshot(value);
      lastError = null;
      if (!snapshot || next.revision > snapshot.revision) {
        snapshot = next;
        render();
      }
      return snapshot;
    }

    async function request(type, patch) {
      const response = await chromeApi.runtime.sendMessage({ type, ...(patch ? { patch } : {}) });
      if (!response?.ok) throw new Error(response?.error?.message || 'Global preferences are unavailable.');
      return response.result;
    }

    function onStorageChange(changes, area) {
      if (disposed || area !== 'local' || !changes[Preferences.STORAGE_KEY]?.newValue) return;
      try { accept(changes[Preferences.STORAGE_KEY].newValue); } catch (error) { reportError(error); }
    }

    function reportError(error) {
      lastError = error;
      options.onError?.(error);
    }

    async function initialize() {
      if (!subscribed) {
        chromeApi.storage.onChanged.addListener(onStorageChange);
        subscribed = true;
      }
      if (snapshot) return snapshot;
      if (!loading) {
        loading = request(Preferences.READ_MESSAGE).then(accept).catch(error => {
          reportError(error);
          return null;
        }).finally(() => { loading = null; });
      }
      return loading;
    }

    function update(input) {
      const patch = Preferences.validatePatch(input);
      if (!Preferences.changedKeys(view(), Preferences.applyPatch(view(), patch)).length) return pending.length ? tail : Promise.resolve(snapshot);
      const operation = { patch };
      pending.push(operation);
      render();
      const result = tail.catch(() => {}).then(() => request(Preferences.PATCH_MESSAGE, patch)).then(Preferences.validateSnapshot).then(value => {
        accept(value);
        pending.splice(pending.indexOf(operation), 1);
        render();
        return snapshot;
      }, error => {
        pending.splice(pending.indexOf(operation), 1);
        render();
        reportError(error);
        throw error;
      });
      tail = result;
      return result;
    }

    function handleInput(event) {
      const field = Object.keys(CONTROLS).find(key => event?.target?.matches?.(CONTROLS[key]));
      if (!field) return null;
      return update({ [field]: ['theme', 'locale'].includes(field) ? event.target.value : Boolean(event.target.checked) });
    }

    return Object.freeze({ initialize, update, handleInput,
      overlay: state => snapshot || pending.length ? { ...state, ...view() } : state,
      refreshView: () => { if (snapshot) render(true); if (lastError) options.onError?.(lastError); },
      destroy() {
        disposed = true;
        if (subscribed) chromeApi.storage.onChanged.removeListener(onStorageChange);
      }
    });
  }

  return Object.freeze({ create });
});
