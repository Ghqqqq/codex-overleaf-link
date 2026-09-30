'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_CONTEXT_WINDOW = 262144;

function buildProviderModelCatalogData(launch = {}) {
  const configured = Array.isArray(launch.models) ? launch.models : [];
  const fallbackId = String(launch.modelId || '').trim();
  const models = configured.length > 0
    ? configured
    : fallbackId
      ? [{ id: fallbackId, label: fallbackId }]
      : [];
  return {
    models: models
      .filter(model => model && typeof model.id === 'string' && model.id.trim())
      .map((model, index) => buildModelEntry(model, launch, index))
  };
}

function prepareProviderModelCatalog(launch) {
  if (!launch) {
    return { launch, close() {} };
  }
  const catalog = buildProviderModelCatalogData(launch);
  if (!catalog.models.length) {
    return { launch, close() {} };
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-models-'));
  const modelCatalogPath = path.join(directory, 'models.json');
  fs.writeFileSync(modelCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  return {
    launch: Object.freeze({ ...launch, modelCatalogPath }),
    close() {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

function buildModelEntry(model, launch, index) {
  const id = String(model.id || '').trim();
  const efforts = normalizeEfforts(model.reasoningEfforts, launch.reasoningEfforts);
  const defaultReasoning = efforts.find(effort => effort !== 'none') || efforts[0] || 'none';
  const contextWindow = normalizeContextWindow(model.contextWindow || launch.contextWindow);
  return {
    slug: id,
    display_name: String(model.label || id),
    description: `Custom provider model ${id}`,
    base_instructions: String(model.baseInstructions || launch.baseInstructions || (
      'You are a coding agent. Use the available shell tool to inspect and modify files, follow the user request precisely, and report the result concisely.'
    )),
    default_reasoning_level: defaultReasoning,
    supported_reasoning_levels: efforts.map(effort => ({
      effort,
      description: effort === 'none' ? 'Reasoning disabled' : `${effort} reasoning effort`
    })),
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 10000 - index,
    supports_reasoning_summaries: efforts.some(effort => effort !== 'none'),
    default_reasoning_summary: 'none',
    support_verbosity: false,
    truncation_policy: { mode: 'bytes', limit: 10000 },
    supports_parallel_tool_calls: Boolean(
      model.supportsParallelToolCalls ?? launch.supportsParallelToolCalls
    ),
    supports_image_detail_original: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: normalizeInputModalities(model.inputModalities || launch.inputModalities),
    supports_search_tool: false
  };
}

function normalizeEfforts(...values) {
  const allowed = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  // Explicit model capabilities must not inherit the selected model's levels.
  const configured = values.find(value => Array.isArray(value) && value.length) || [];
  const normalized = configured
    .map(value => String(value || '').trim().toLowerCase())
    .filter(value => allowed.has(value));
  return Array.from(new Set(normalized.length ? normalized : ['none']));
}

function normalizeContextWindow(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_CONTEXT_WINDOW;
  return Math.min(4000000, Math.max(8192, parsed));
}

function normalizeInputModalities(values) {
  const normalized = (Array.isArray(values) ? values : ['text'])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(value => value === 'text' || value === 'image');
  const unique = Array.from(new Set(normalized));
  return unique.includes('text') ? unique : ['text', ...unique];
}

module.exports = {
  buildProviderModelCatalogData,
  prepareProviderModelCatalog
};
