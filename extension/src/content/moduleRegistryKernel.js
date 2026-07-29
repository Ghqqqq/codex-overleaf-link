(function initCodexOverleafModuleRegistry(root, factory) {
  'use strict';

  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CodexOverleafModuleRegistry = api;
  }
})(typeof window !== 'undefined' ? window : globalThis, function moduleRegistryFactory(root) {
  'use strict';

  const definitions = new Map();
  const instances = new Map();

  function define(name, dependencies, factory) {
    name = normalizeName(name);
    if (definitions.has(name) || instances.has(name)) {
      throw new Error(`Codex Overleaf module is already defined: ${name}`);
    }
    if (!Array.isArray(dependencies) || typeof factory !== 'function') {
      throw new TypeError(`Codex Overleaf module ${name} has an invalid definition.`);
    }
    definitions.set(name, {
      dependencies: dependencies.map(normalizeName),
      factory
    });
    Object.defineProperty(root, `CodexOverleaf${name}`, {
      configurable: true,
      enumerable: false,
      get() {
        return resolve(name);
      }
    });
  }

  function resolve(name, stack = []) {
    name = normalizeName(name);
    if (instances.has(name)) {
      return instances.get(name);
    }
    const definition = definitions.get(name);
    if (!definition) {
      const legacyValue = readLegacyValue(name);
      if (legacyValue) {
        return legacyValue;
      }
      throw moduleError('content_dependency_missing', `Codex Overleaf module is not defined: ${name}`, {
        moduleName: name,
        resolutionStack: stack
      });
    }
    if (stack.includes(name)) {
      const cycle = [...stack.slice(stack.indexOf(name)), name];
      throw moduleError('content_dependency_cycle', `Codex Overleaf module dependency cycle: ${cycle.join(' -> ')}`, {
        cycle
      });
    }
    const nextStack = [...stack, name];
    const args = definition.dependencies.map(dependency => resolve(dependency, nextStack));
    const value = definition.factory(...args);
    if (!value) {
      throw moduleError('content_dependency_invalid_export', `Codex Overleaf module returned no export: ${name}`, {
        moduleName: name
      });
    }
    instances.set(name, value);
    definitions.delete(name);
    Object.defineProperty(root, `CodexOverleaf${name}`, {
      configurable: true,
      enumerable: false,
      value,
      writable: false
    });
    return value;
  }

  function resolveAll(names) {
    const resolved = {};
    const failures = [];
    for (const name of names || []) {
      try {
        resolved[name] = resolve(name);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      const error = moduleError(
        'content_dependency_resolution_failed',
        failures.map(item => item.message).join('; '),
        { failures }
      );
      throw error;
    }
    return resolved;
  }

  function readLegacyValue(name) {
    const descriptor = Object.getOwnPropertyDescriptor(root, `CodexOverleaf${name}`);
    if (!descriptor || typeof descriptor.get === 'function') {
      return null;
    }
    return descriptor.value || null;
  }

  function normalizeName(value) {
    const name = String(value || '').trim();
    if (!/^[A-Z][A-Za-z0-9_$]*$/.test(name)) {
      throw new TypeError(`Invalid Codex Overleaf module name: ${name || '(empty)'}`);
    }
    return name;
  }

  function moduleError(code, message, detail) {
    return Object.assign(new Error(message), { code, detail });
  }

  return Object.freeze({
    define,
    resolve,
    resolveAll
  });
});
