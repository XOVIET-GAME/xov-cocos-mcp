'use strict';

// Conservative policy defaults. Unknown tools are treated as editor-exclusive
// writes so an arbitrary extension command cannot bypass serialization.

const READ_TOOLS = new Set([
  'get_editor_state', 'get_tool_catalog', 'check_for_updates', 'get_selection',
  'get_scene_info', 'get_hierarchy', 'find_nodes', 'inspect_node', 'get_project_info',
  'list_scenes', 'list_prefabs', 'inspect_prefab', 'validate_prefab_references',
  'inspect_prefab_instance', 'list_assets', 'inspect_asset', 'get_editor_selection',
  'list_components', 'inspect_component', 'list_cameras', 'list_animations',
  'get_recent_logs', 'search_project_logs', 'validate_scene', 'get_performance_snapshot',
  'get_build_status', 'get_preview_mode',
]);

const SCRIPT_TOOLS = new Set(['execute_javascript', 'execute_editor_script', 'execute_scene_script']);
const INTERACTIVE_TOOLS = new Set(['set_selection', 'select_asset', 'send_key_press', 'send_key_combo', 'send_mouse_click', 'send_mouse_drag', 'capture_screenshot', 'capture_editor_window_screenshot']);
const LONG_RUNNING_TOOLS = new Set(['run_project_preview', 'run_script_diagnostics', 'build_project']);

function getToolPolicy(name, args = {}) {
  const toolName = String(name || '');
  let access = READ_TOOLS.has(toolName) ? 'read' : 'write';
  let scope = 'editor';
  let cancellable = true;
  let timeoutMs = 30000;
  let idempotent = access === 'read';
  if (SCRIPT_TOOLS.has(toolName)) {
    access = 'exclusive';
    scope = 'script';
    timeoutMs = 60000;
    idempotent = false;
  } else if (INTERACTIVE_TOOLS.has(toolName)) {
    access = 'exclusive';
    scope = 'interactive';
    idempotent = false;
  } else if (LONG_RUNNING_TOOLS.has(toolName)) {
    access = 'write';
    scope = 'long-running';
    timeoutMs = 120000;
    idempotent = false;
  }
  const resources = buildResources(toolName, args, access);
  const requiredCapability = capabilityForTool(toolName);
  return { name: toolName, access, scope, resources, cancellable, timeoutMs, idempotent, requiredCapability };
}

function capabilityForTool(name) {
  if (/preview|build/i.test(name)) return 'preview';
  if (/screenshot|mouse|key|input/i.test(name)) return 'screenshot';
  if (/scene|hierarchy|node|selection|component/i.test(name)) return 'scene';
  if (/asset|prefab/i.test(name)) return 'asset';
  return '';
}

function buildResources(name, args, access) {
  const projectId = args.projectId || args.project || 'current';
  const editorId = args.targetId || args.editorInstanceId || 'current';
  const resources = [];
  resources.push({ name: 'project:' + projectId, mode: access === 'read' ? 'read' : 'write' });
  resources.push({ name: 'editor:' + editorId, mode: access === 'read' ? 'read' : (access === 'exclusive' ? 'exclusive' : 'write') });
  if (/scene|node|hierarchy|selection/i.test(name)) {
    resources.push({ name: 'scene:' + (args.sceneUuid || args.scene || 'current'), mode: access === 'read' ? 'read' : 'write' });
  }
  if (/asset|prefab/i.test(name)) {
    resources.push({ name: 'asset:' + (args.uuid || args.asset || args.path || 'current'), mode: access === 'read' ? 'read' : 'write' });
  }
  if (/file|instruction|skill|project/i.test(name)) {
    resources.push({ name: 'file:' + (args.path || 'project'), mode: access === 'read' ? 'read' : 'write' });
  }
  if (/preview/i.test(name)) resources.push({ name: 'preview:' + editorId, mode: 'exclusive' });
  return resources;
}

module.exports = { getToolPolicy, buildResources, READ_TOOLS, SCRIPT_TOOLS };
