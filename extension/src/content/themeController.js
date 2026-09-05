(function initCodexOverleafTheme(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafTheme = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function themeFactory() {
  'use strict';

  // The user-selectable theme preferences. 'dark' is the historical default and
  // the CSS baseline (no [data-theme="light"] override applies to it); 'auto'
  // follows the operating system via prefers-color-scheme.
  const THEMES = ['dark', 'light', 'auto'];
  const DEFAULT_THEME = 'dark';
  const RESOLVED_DARK = 'dark';
  const RESOLVED_LIGHT = 'light';

  // Coerce an arbitrary stored value (possibly undefined or stale) to a valid
  // preference, falling back to the dark default.
  function normalizeThemePreference(value) {
    return THEMES.indexOf(value) !== -1 ? value : DEFAULT_THEME;
  }

  // The matchMedia list for "OS prefers light", or null when matchMedia is
  // unavailable (e.g. the Node test environment).
  function prefersLightMedia() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return null;
    }
    return window.matchMedia('(prefers-color-scheme: light)');
  }

  // Resolve a preference to a concrete applied theme ('dark' | 'light'). 'auto'
  // consults the OS; the optional mediaQueryList lets tests inject a result
  // without a real matchMedia. When the OS preference can't be read, auto falls
  // back to dark (the safe default that needs no override block).
  function resolveTheme(preference, mediaQueryList) {
    const pref = normalizeThemePreference(preference);
    if (pref !== 'auto') {
      return pref;
    }
    const mql = mediaQueryList !== undefined ? mediaQueryList : prefersLightMedia();
    return mql && mql.matches ? RESOLVED_LIGHT : RESOLVED_DARK;
  }

  // Write the resolved theme onto the panel root's data-theme attribute. Dark is
  // the CSS baseline, but we always set the resolved value explicitly so the
  // attribute is a faithful mirror of what is showing (and so auto can flip it
  // live). Returns the resolved theme.
  function applyTheme(preference, panelRoot, mediaQueryList) {
    const resolved = resolveTheme(preference, mediaQueryList);
    if (panelRoot && typeof panelRoot.setAttribute === 'function') {
      panelRoot.setAttribute('data-theme', resolved);
      for (const target of panelRoot.ownerDocument?.querySelectorAll?.('.codex-provider-dialog-root, #codex-overleaf-launcher') || []) {
        target.setAttribute('data-theme', resolved);
      }
    }
    return resolved;
  }

  // While the preference is 'auto', re-apply whenever the OS light/dark setting
  // changes. Returns a disposer that detaches the listener. For non-auto
  // preferences (or when matchMedia is unavailable) it attaches nothing and
  // returns a no-op disposer, so callers can unconditionally dispose+rewatch on
  // every preference change.
  function watchAuto(preference, panelRoot, onChange) {
    if (normalizeThemePreference(preference) !== 'auto') {
      return function noopDisposer() {};
    }
    const mql = prefersLightMedia();
    if (!mql || typeof mql.addEventListener !== 'function') {
      return function noopDisposer() {};
    }
    const handler = function handleSchemeChange() {
      const resolved = applyTheme('auto', panelRoot, mql);
      if (typeof onChange === 'function') {
        onChange(resolved);
      }
    };
    mql.addEventListener('change', handler);
    return function disposeWatcher() {
      mql.removeEventListener('change', handler);
    };
  }

  return {
    THEMES,
    DEFAULT_THEME,
    normalizeThemePreference,
    resolveTheme,
    applyTheme,
    watchAuto
  };
});
