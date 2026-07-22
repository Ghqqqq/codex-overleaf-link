(function initCodexOverleafProjectProviderSelection() {
  'use strict';

  function create(deps = {}) {
    async function confirmSwitch({ providerName } = {}) {
      if ((deps.getRunningSessionIds?.() || []).length) {
        deps.showToast?.(deps.tx(
          'Wait for the running task to finish before switching providers.',
          '请等待正在运行的任务结束后再切换模型服务。'
        ), { status: 'warning' });
        return false;
      }
      return deps.showConfirm?.({
        title: deps.tx('Switch provider for this project?', '切换当前项目的模型服务？'),
        message: deps.tx(
          `All sessions in this project will use ${providerName || 'the selected provider'}. The model, reasoning, and speed choices may change; existing run history stays unchanged, while future turns start fresh provider threads and may behave differently.`,
          `当前项目的所有会话都将使用 ${providerName || '所选模型服务'}。模型、推理强度和速度选项可能变化；已有运行历史保持不变，后续轮次会创建新的服务线程，输出效果也可能变化。`
        ),
        confirmLabel: deps.tx('Switch provider', '切换模型服务'),
        cancelLabel: deps.tr('confirmDefaultCancel')
      });
    }

    function commit(providerId, model) {
      const state = deps.getState?.() || {};
      const nextProviderId = providerId || 'builtin';
      const providerChanged = nextProviderId !== (state.providerId || 'builtin');
      const nextModel = model || deps.readSelectedModel?.() || state.model || '';
      const nextReasoningEffort = deps.getPanel?.()?.querySelector('[data-reasoning]')?.value || state.reasoningEffort;
      const nextSpeedTier = deps.readSelectedSpeed?.() || state.speedTier;
      const runSelection = deps.getRunSelection?.(nextProviderId);
      const nextProviderRevision = Number(runSelection?.providerRevision || 0);
      const sessions = (state.sessions || []).map(session => ({
        ...session,
        providerId: nextProviderId,
        model: nextModel,
        reasoningEffort: nextReasoningEffort,
        speedTier: nextSpeedTier,
        codexThreadId: providerChanged ? '' : session.codexThreadId,
        pendingInputs: (session.pendingInputs || []).map(item => ({
          ...item,
          payload: {
            ...(item.payload || {}),
            providerId: nextProviderId,
            providerRevision: nextProviderRevision,
            model: nextModel,
            reasoningEffort: nextReasoningEffort,
            speedTier: nextSpeedTier
          }
        }))
      }));
      deps.setState?.(deps.normalizeState({
        ...state,
        providerId: nextProviderId,
        providerRevision: nextProviderRevision,
        model: nextModel,
        reasoningEffort: nextReasoningEffort,
        speedTier: nextSpeedTier,
        sessions
      }));
      deps.applyStateToPanel?.();
    }

    return { confirmSwitch, commit };
  }

  window.CodexOverleafProjectProviderSelection = { create };
})();
