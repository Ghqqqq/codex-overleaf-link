const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const REGISTRY_PATH = path.join(
  __dirname,
  '..',
  'extension',
  'src',
  'content',
  'moduleRegistryKernel.js'
);
const REGISTRY_SOURCE = fs.readFileSync(REGISTRY_PATH, 'utf8');

function createRegistryContext(initial = {}) {
  const context = vm.createContext({ ...initial });
  vm.runInContext(REGISTRY_SOURCE, context, { filename: REGISTRY_PATH });
  return {
    context,
    registry: context.CodexOverleafModuleRegistry
  };
}

test('content module registry resolves explicit dependencies independent of definition order', () => {
  const { context, registry } = createRegistryContext();
  let leafFactoryCalls = 0;

  registry.define('Parent', ['Leaf'], (leaf) => ({ leaf }));
  registry.define('Leaf', [], () => {
    leafFactoryCalls += 1;
    return { value: 42 };
  });

  const parent = registry.resolve('Parent');
  assert.equal(parent.leaf.value, 42);
  assert.equal(registry.resolve('Parent'), parent);
  assert.equal(context.CodexOverleafParent, parent);
  assert.equal(leafFactoryCalls, 1);
});

test('content module registry supports legacy compatibility publications', () => {
  const legacy = { value: 'legacy' };
  const { registry } = createRegistryContext({
    CodexOverleafLegacyDependency: legacy
  });

  registry.define('Consumer', ['LegacyDependency'], (dependency) => ({ dependency }));
  assert.equal(registry.resolve('Consumer').dependency, legacy);
});

test('content module registry fails closed on missing dependencies', () => {
  const { registry } = createRegistryContext();
  registry.define('Consumer', ['MissingDependency'], (dependency) => ({ dependency }));

  assert.throws(
    () => registry.resolve('Consumer'),
    error => error?.code === 'content_dependency_missing' &&
      error?.detail?.moduleName === 'MissingDependency'
  );
});

test('content module registry reports dependency cycles with the complete cycle', () => {
  const { registry } = createRegistryContext();
  registry.define('Alpha', ['Beta'], (beta) => ({ beta }));
  registry.define('Beta', ['Alpha'], (alpha) => ({ alpha }));

  assert.throws(
    () => registry.resolve('Alpha'),
    error => error?.code === 'content_dependency_cycle' &&
      JSON.stringify(error?.detail?.cycle) === JSON.stringify(['Alpha', 'Beta', 'Alpha'])
  );
});

test('content module registry aggregates resolveAll failures', () => {
  const { registry } = createRegistryContext();
  registry.define('Healthy', [], () => ({ ok: true }));

  assert.throws(
    () => registry.resolveAll(['Healthy', 'MissingOne', 'MissingTwo']),
    error => error?.code === 'content_dependency_resolution_failed' &&
      error?.detail?.failures?.length === 2
  );
});
