(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('StorageValuePruning', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function removeEmptySummaryFields(value) {
    var result = {};
    var keys = Object.keys(value || {});
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var item = value[key];
      if (item === undefined || item === '' || item === null) {
        continue;
      }
      if (Array.isArray(item) && item.length === 0) {
        continue;
      }
      if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0) {
        continue;
      }
      result[key] = item;
    }
    return result;
  }

  function removeEmptyFields(value) {
    var result = {};
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (value[key] !== undefined && value[key] !== '') {
        result[key] = value[key];
      }
    }
    return result;
  }

  return { removeEmptySummaryFields, removeEmptyFields };
});
