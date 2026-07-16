(function initCodexOverleafNativeChannel(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafNativeChannel = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function nativeChannelFactory() {
  'use strict';

  function create(deps = {}) {
    const runtime = deps.chrome?.runtime || chrome.runtime;
    const cryptoImpl = deps.crypto || crypto;
    let activeRequestId = null;
    const backgroundEventHandlers = new Map();

    function sendNative(payload) {
      const id = cryptoImpl.randomUUID();
      activeRequestId = id;
      return runtime.sendMessage({
        type: 'codex-overleaf/native-request',
        payload: {
          id,
          ...payload
        }
      });
    }

    function sendBackgroundNative(payload, onEvent) {
      const id = cryptoImpl.randomUUID();
      if (typeof onEvent === 'function') {
        backgroundEventHandlers.set(id, onEvent);
      }
      return runtime.sendMessage({
        type: 'codex-overleaf/native-request',
        payload: {
          id,
          ...payload
        }
      }).finally(() => {
        backgroundEventHandlers.delete(id);
      });
    }

    function getActiveRequestId() {
      return activeRequestId;
    }

    function clearActiveRequest() {
      activeRequestId = null;
    }

    function shouldHandleNativeEvent(message = {}) {
      return message?.type === 'codex-overleaf/native-event' && message.id === activeRequestId;
    }

    function handleBackgroundNativeEvent(message = {}) {
      if (message?.type !== 'codex-overleaf/native-event') {
        return false;
      }
      const handler = backgroundEventHandlers.get(message.id);
      if (!handler) {
        return false;
      }
      handler(message.event);
      return true;
    }

    return {
      clearActiveRequest,
      getActiveRequestId,
      handleBackgroundNativeEvent,
      sendBackgroundNative,
      sendNative,
      shouldHandleNativeEvent
    };
  }

  return {
    create
  };
});
