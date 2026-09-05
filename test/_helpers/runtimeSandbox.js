// Shared source snippets for the `Function(...)` sandboxes that execute
// functions extracted from contentRuntime.js (and its carved modules).
//
// Before v1.4.6 every harness hand-declared its own pile of ~10-30 no-op
// runtime stubs, so each new runtime dependency (applyPanelTheme in v1.4.2,
// stopRunElapsedTick in v1.3.10, ...) had to be patched into every affected
// sandbox individually. The registry below is the single place to add a stub
// when an extracted function gains a collaborator.
//
// Usage:
//   const { runtimeStubs, FAKE_INPUT_SOURCE } = require('./_helpers/runtimeSandbox');
//   const harness = Function(`
//     ...bespoke locals/controls...
//     ${runtimeStubs({ omit: ['getCurrentProjectId', 'saveState'] })}
//     ...bespoke stub overrides + extracted functions...
//   `);
//
// `omit` removes registry defaults the test replaces with its own versions.
// Stubs are standalone function declarations (hoisted), so ordering between
// the registry block, bespoke overrides, and extracted code does not matter —
// but a test MUST omit any name it redefines (duplicate declarations would
// silently shadow by source order).

const RUNTIME_STUBS = {
  // i18n
  tr: "function tr(key) { return key; }",
  tx: "function tx(english) { return english; }",
  // popover/menu closers
  closeDiagnosticsMenu: 'function closeDiagnosticsMenu() {}',
  closeDiagnosticsResult: 'function closeDiagnosticsResult() {}',
  closeModelConfigPopover: 'function closeModelConfigPopover() {}',
  closeContextTray: 'function closeContextTray() {}',
  closeSlashMenu: 'function closeSlashMenu() {}',
  // settings / governance / skills
  syncProjectSettingsEditorForProject: 'function syncProjectSettingsEditorForProject() {}',
  refreshLocalSkills: 'function refreshLocalSkills() { return Promise.resolve(); }',
  setGovernanceRulesForCurrentProject: 'function setGovernanceRulesForCurrentProject() {}',
  readGovernanceRulesFromSettings: 'function readGovernanceRulesFromSettings() { return {}; }',
  readSkillLoadingSettingsFromSettings: 'function readSkillLoadingSettingsFromSettings() { return {}; }',
  getSkillLoadingSettings: 'function getSkillLoadingSettings() { return { loadCodexLocalSkills: true, loadCodexOverleafSkills: true }; }',
  setSkillLoadingSettings: 'function setSkillLoadingSettings() {}',
  renderLocalSkillList: 'function renderLocalSkillList() {}',
  updateSkillsEntrySummary: 'function updateSkillsEntrySummary() {}',
  // experimental OT
  syncExperimentalOtToggleForProject: 'function syncExperimentalOtToggleForProject() {}',
  setExperimentalOtEnabledForProject: 'function setExperimentalOtEnabledForProject() {}',
  updateOtStatusDisplay: 'function updateOtStatusDisplay() {}',
  updateExperimentalOtToggleControl: 'function updateExperimentalOtToggleControl() {}',
  syncOtWarmMirrorStateForProject: 'function syncOtWarmMirrorStateForProject() {}',
  syncMirrorPrefetchStateForProject: 'function syncMirrorPrefetchStateForProject() {}',
  // composer / model controls
  updateActiveSession: 'function updateActiveSession(s) { return s; }',
  readSelectedModelInput: "function readSelectedModelInput() { return ''; }",
  readSelectedSpeedInput: "function readSelectedSpeedInput() { return 'standard'; }",
  getRenderedModelEntries: 'function getRenderedModelEntries() { return []; }',
  renderReasoningOptions: 'function renderReasoningOptions() {}',
  renderSpeedOptions: 'function renderSpeedOptions() {}',
  renderModelConfigChoices: 'function renderModelConfigChoices() {}',
  updateModelDisplay: 'function updateModelDisplay() {}',
  syncModeControls: 'function syncModeControls() {}',
  // session / view refresh
  applySessionLabel: 'function applySessionLabel() {}',
  renderSessionList: 'function renderSessionList() {}',
  applyPanelTheme: 'function applyPanelTheme() {}',
  renderRecentProjectsVariant: 'function renderRecentProjectsVariant() { return Promise.resolve(); }',
  isProjectEditorRoute: 'function isProjectEditorRoute() { return true; }',
  // persistence
  getGlobalPreferences: 'function getGlobalPreferences() { return { handleInput: () => null, overlay: value => value, initialize: async () => null, refreshView() {}, update: async () => {} }; }',
  saveState: 'async function saveState() {}',
  saveStateSoon: 'function saveStateSoon() {}',
  notifyAggressiveCompactionOnce: 'function notifyAggressiveCompactionOnce() {}',
  persistComposerAttachmentsToState: 'function persistComposerAttachmentsToState() {}',
  // history & storage (v1.7.5 settings card)
  refreshStorageUsageSummary: 'function refreshStorageUsageSummary() {}',
  // timeline view-state accessors (the carved run-timeline module reads
  // mutable runtime state through these; sandboxes usually declare the
  // backing locals themselves, so the defaults resolve them when present)
  getPanel: "function getPanel() { return typeof panel !== 'undefined' ? panel : null; }",
  getState: "function getState() { return typeof state !== 'undefined' ? state : null; }",
  setState: "function setState(next) { if (typeof state !== 'undefined') { state = next; } }",
  getCurrentRunView: "function getCurrentRunView() { return typeof currentRunView !== 'undefined' ? currentRunView : null; }",
  getCurrentOtStatus: "function getCurrentOtStatus() { return typeof currentOtStatus !== 'undefined' ? currentOtStatus : 'off'; }",
  getLastExperimentalOtProjectId: "function getLastExperimentalOtProjectId() { return typeof lastExperimentalOtProjectId !== 'undefined' ? lastExperimentalOtProjectId : ''; }",
  stopRunElapsedTick: 'function stopRunElapsedTick() {}'
};

/**
 * Emit the registry as one source block, minus the names a test redefines.
 * Unknown omit names fail loudly so typos don't silently keep a default.
 */
function runtimeStubs({ omit = [] } = {}) {
  for (const name of omit) {
    if (!Object.prototype.hasOwnProperty.call(RUNTIME_STUBS, name)) {
      throw new Error(`runtimeStubs: unknown omit name "${name}"`);
    }
  }
  const omitted = new Set(omit);
  return Object.entries(RUNTIME_STUBS)
    .filter(([name]) => !omitted.has(name))
    .map(([, source]) => source)
    .join('\n');
}

// The composer-controls fake used by the readPanelInputs-family harnesses.
const FAKE_INPUT_SOURCE = "const fakeInput = (value = '') => ({ value, checked: false });";

/**
 * A panel façade whose querySelector resolves from a `controls` map declared
 * by the test. `view` seeds panel.dataset.view (the settings-visibility guard
 * in readPanelInputs branches on it).
 */
function panelFromControlsSource(view = 'settings') {
  return `
    const panel = {
      dataset: { view: '${view}' },
      querySelector(selector) {
        return Object.prototype.hasOwnProperty.call(controls, selector) ? controls[selector] : null;
      },
      querySelectorAll() { return []; }
    };
  `;
}

module.exports = {
  RUNTIME_STUBS,
  runtimeStubs,
  FAKE_INPUT_SOURCE,
  panelFromControlsSource
};
