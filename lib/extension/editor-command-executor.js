'use strict';

// Phase 1 executor: executes Gateway-dispatched command requests inside the
// Cocos Editor context. The Gateway forwards tool calls to the extension over
// the control channel; the extension runs them through the existing tool
// registry (browser.js) and returns command.result.
//
function createEditorCommandExecutor({ toolRegistry, getStatus, logger }) {
  const log = logger && typeof logger.log === 'function' ? logger : { log() {} };
  const active = new Map();

  async function execute(request) {
    const params = request.params || {};
    if (params.deadline) {
      const deadline = Date.parse(params.deadline);
      if (Number.isFinite(deadline) && Date.now() > deadline) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32011, message: 'Request deadline expired before Editor execution.' },
        };
      }
    }
    const tool = params.tool;
    if (!tool || typeof tool.name !== 'string' || !tool.name) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32602, message: "Invalid command.request: 'tool.name' is required." },
      };
    }
    if (!toolRegistry || typeof toolRegistry.callTool !== 'function') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32001, message: 'Editor tool registry is not available.' },
      };
    }

    const requestId = params.requestId || request.id;
    const state = { cancelled: false };
    active.set(String(requestId), state);
    try {
      const value = await toolRegistry.callTool(tool.name, tool.arguments || {});
      if (state.cancelled) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32015, message: 'Editor command was cancelled.' },
        };
      }
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tool: tool.name,
          value,
          executedBy: getStatus ? getStatus().projectName : '',
        },
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tool: tool.name,
          value: null,
          error: error.message,
        },
      };
    } finally {
      active.delete(String(requestId));
    }
  }

  function cancel(requestId) {
    if (!requestId) return false;
    const state = active.get(String(requestId));
    if (!state) return false;
    state.cancelled = true;
    return true;
  }

  return { execute, cancel };
}

module.exports = {
  createEditorCommandExecutor,
};
