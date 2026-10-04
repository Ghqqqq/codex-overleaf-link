(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('FileMoveApproval', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';
  async function confirm(operations, deps) {
    const original = deps.originalOperations || operations;
    const wholePlan = original.some(op => op.type === 'move')
      || original.some(op => op.type === 'delete') && original.some(op => ['create', 'binary-create'].includes(op.type));
    if (!wholePlan) return null;
    const { tx, showPluginConfirm } = deps;
    const label = operation => ({
      move: tx('Move', '移动'), create: tx('Create', '新建'), delete: tx('Delete', '删除'), edit: tx('Edit', '修改'),
      'binary-create': tx('Create asset', '新建资源'), 'overwrite-binary': tx('Replace asset', '替换资源')
    }[operation.type] || operation.type) + ': ' + operation.path + (operation.to ? ' → ' + operation.to : '');
    const key = operation => [operation.type, operation.path, operation.to || ''].join('\0');
    const allowed = new Set(operations.map(key));
    const approved = await showPluginConfirm({
      title: tx('Apply this complete file plan?', '应用整份文件操作计划？'),
      message: tx('All available changes below are approved together. Blocked items will not run. Cancel keeps all files unchanged.',
        '以下可执行改动作为完整计划一起确认，已阻止的项目不会执行。取消后不会应用任何一项。') + '\n\n'
        + original.map(operation => label(operation) + (allowed.has(key(operation)) ? '' : tx(' (blocked)', '（已阻止）'))).join('\n'),
      confirmLabel: tx('Apply file plan', '应用文件计划'), cancelLabel: tx('Cancel entire plan', '取消整份计划'), destructive: true
    });
    return approved ? { approved: true, operations, skipped: [] } : { approved: false, operations: [],
      skipped: operations.map(operation => ({ operation, result: { ok: false, code: 'file_plan_confirmation_rejected',
        changedDocument: false, reason: tx('The complete file plan was cancelled; no part was applied.', '整份文件计划已取消，未应用任何部分。') } })) };
  }
  return { confirm };
});
