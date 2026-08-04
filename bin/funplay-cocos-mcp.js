#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const DEFAULT_URL = 'http://127.0.0.1:8787/mcp';
const DEFAULT_TIMEOUT_SECONDS = 120;
const ACCEPT_HEADER = 'application/json, text/event-stream';
const GATEWAY_UNAVAILABLE_CODE = -32050;

async function main() {
  const args = process.argv.slice(2);

  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printHelp();
    return 0;
  }

  if (hasFlag(args, '--version')) {
    console.error(`funplay-cocos-mcp ${readPackageVersion()}`);
    return 0;
  }

  const command = parseCommand(args);
  if (command.kind === 'invalid') {
    console.error(command.message);
    return 2;
  }
  const optionUrl = getOption(args, '--url');
  const gatewayUrl = process.env.FUNPLAY_COCOS_GATEWAY_URL;
  const legacyUrl = process.env.FUNPLAY_COCOS_MCP_URL;
  const urlText = optionUrl
    || gatewayUrl
    || legacyUrl
    || DEFAULT_URL;
  const timeoutText = getOption(args, '--timeout-seconds')
    || process.env.FUNPLAY_COCOS_MCP_TIMEOUT_SECONDS
    || String(DEFAULT_TIMEOUT_SECONDS);

  const endpoint = parseEndpoint(urlText, { defaultPath: optionUrl || legacyUrl ? '/' : '/mcp' });
  if (!endpoint) {
    console.error(`Invalid --url value: ${urlText}`);
    return 2;
  }

  const timeoutSeconds = Number.parseInt(timeoutText, 10);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    console.error(`Invalid timeout value: ${timeoutText}`);
    return 2;
  }

  const timeoutMs = timeoutSeconds * 1000;
  const authToken = getOption(args, '--token') || process.env.FUNPLAY_COCOS_GATEWAY_TOKEN || '';

  if (command.kind === 'targets-list') {
    return runTargetCommand({ endpoint, timeoutMs, targetId: '', authToken });
  }
  if (command.kind === 'target-health') {
    return runTargetCommand({ endpoint, timeoutMs, targetId: command.targetId, authToken });
  }
  if (command.kind === 'call') {
    return runOneShotCall({
      endpoint,
      timeoutMs,
      authToken,
      toolName: command.toolName,
      argumentsText: command.argumentsText,
      targetId: command.targetId,
    });
  }

  console.error(`[Funplay Cocos MCP] Bridging stdio to central Gateway ${endpoint.href}`);
  await bridgeStdioToHttp({
    input: process.stdin,
    output: process.stdout,
    endpoint,
    timeoutMs,
    authToken,
  });
  return 0;
}

function parseCommand(args) {
  const index = firstPositionalIndex(args);
  const first = index >= 0 ? args[index] : '';
  if (!first || first.toLowerCase() === 'mcp') {
    return { kind: 'mcp' };
  }
  if (first.toLowerCase() === 'targets') {
    if (args[index + 1] && args[index + 1].toLowerCase() === 'list') {
      return { kind: 'targets-list' };
    }
    return { kind: 'invalid', message: 'Usage: targets list' };
  }
  if (first.toLowerCase() === 'target') {
    if (args[index + 1] && args[index + 1].toLowerCase() === 'health' && args[index + 2]) {
      return { kind: 'target-health', targetId: args[index + 2] };
    }
    return { kind: 'invalid', message: 'Usage: target health <targetId>' };
  }
  if (first.toLowerCase() === 'call') {
    const toolName = args[index + 1] && !args[index + 1].startsWith('-') ? args[index + 1] : '';
    const argumentsText = args[index + 2] && !args[index + 2].startsWith('-') ? args[index + 2] : '{}';
    if (!toolName) return { kind: 'invalid', message: 'Usage: call <toolName> [jsonArguments] [--target <targetId>]' };
    return { kind: 'call', toolName, argumentsText, targetId: getOption(args, '--target') };
  }
  return { kind: 'invalid', message: `Unknown command: ${first}` };
}

function firstPositionalIndex(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('-')) return index;
    if (arg === '--url' || arg === '--timeout-seconds' || arg === '--token' || arg === '--target') index += 1;
  }
  return -1;
}

async function runOneShotCall({ endpoint, timeoutMs, authToken, toolName, argumentsText, targetId }) {
  let toolArguments;
  try {
    toolArguments = JSON.parse(argumentsText || '{}');
    if (!toolArguments || typeof toolArguments !== 'object' || Array.isArray(toolArguments)) throw new Error('arguments must be a JSON object');
  } catch (error) {
    console.error(`Invalid JSON arguments: ${error.message}`);
    return 2;
  }
  let sessionId = '';
  try {
    const initialize = await postJsonRpc(endpoint, JSON.stringify({
      jsonrpc: '2.0',
      id: 'cli-initialize',
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cocos-cli', version: readPackageVersion() } },
    }), { timeoutMs, sessionId: '', authToken });
    sessionId = initialize.headers['mcp-session-id'] || '';
    const response = await postJsonRpc(endpoint, JSON.stringify({
      jsonrpc: '2.0',
      id: 'cli-call',
      method: 'tools/call',
      params: { name: toolName, arguments: toolArguments, ...(targetId ? { targetId } : {}) },
    }), { timeoutMs, sessionId, authToken });
    if (response.body.trim()) process.stdout.write(response.body + '\n');
    return response.statusCode >= 200 && response.statusCode < 300 ? 0 : 1;
  } catch (error) {
    console.error(formatGatewayUnavailable(error, endpoint));
    return 1;
  } finally {
    if (sessionId) await deleteSession(endpoint, { timeoutMs, sessionId, authToken }).catch(() => {});
  }
}

async function runTargetCommand({ endpoint, timeoutMs, targetId, authToken }) {
  if (!targetId && endpoint.pathname !== '/mcp') {
    endpoint.pathname = '/mcp';
  }
  const healthEndpoint = new URL(endpoint.href);
  healthEndpoint.pathname = '/health';
  healthEndpoint.search = targetId ? `?targetId=${encodeURIComponent(targetId)}` : '';
  try {
    const response = await getJson(healthEndpoint, { timeoutMs, authToken });
    if (response.statusCode < 200 || response.statusCode >= 300 || !response.body) {
      throw gatewayUnavailable(healthEndpoint, `Gateway returned HTTP ${response.statusCode}.`);
    }
    const payload = response.body;
    if (targetId) {
      const target = payload.target || (Array.isArray(payload.targets)
        ? payload.targets.find((item) => item.targetId === targetId || item.editorInstanceId === targetId)
        : null);
      if (!target) {
        console.error(`Target not found: ${targetId}`);
        return 1;
      }
      process.stdout.write(`${JSON.stringify(target)}\n`);
      return 0;
    }
    process.stdout.write(`${JSON.stringify(payload.targets || [])}\n`);
    return 0;
  } catch (error) {
    console.error(formatGatewayUnavailable(error, healthEndpoint));
    return 1;
  }
}

async function bridgeStdioToHttp({ input, output, endpoint, timeoutMs, authToken }) {
  let sessionId = '';

  while (true) {
    const message = await readMessage(input);
    if (message === null) {
      if (sessionId && endpoint.pathname === '/mcp') {
        await deleteSession(endpoint, { timeoutMs, sessionId, authToken }).catch(() => {});
      }
      return;
    }

    let parsed = null;
    let requestId = null;
    try {
      parsed = JSON.parse(message);
      requestId = getRequestId(parsed);
    } catch (error) {
      await writeJsonRpcError(output, null, -32700, 'Parse error');
      continue;
    }

    try {
      const response = await postJsonRpc(endpoint, message, {
        timeoutMs,
        sessionId,
        authToken
      });

      const nextSessionId = response.headers['mcp-session-id'];
      if (typeof nextSessionId === 'string' && nextSessionId) {
        sessionId = nextSessionId;
      }

      if (response.statusCode >= 200 && response.statusCode < 300 && response.body.trim()) {
        await writeMessage(output, response.body);
        continue;
      }

      if (response.statusCode >= 200 && response.statusCode < 300 && isNotification(parsed)) {
        continue;
      }

      if (requestId !== null) {
        const messageText = response.body.trim()
          ? `Cocos MCP server returned HTTP ${response.statusCode}: ${response.body}`
          : `Cocos MCP server returned HTTP ${response.statusCode}.`;
        await writeJsonRpcError(output, requestId, -32000, messageText);
      }
    } catch (error) {
      console.error(`[Funplay Cocos MCP] ${formatGatewayUnavailable(error, endpoint)}`);
      if (requestId !== null) {
        await writeJsonRpcError(output, requestId, GATEWAY_UNAVAILABLE_CODE, formatGatewayUnavailable(error, endpoint));
      }
    }
  }
}

function deleteSession(endpoint, { timeoutMs, sessionId, authToken }) {
  return new Promise((resolve, reject) => {
    const client = endpoint.protocol === 'https:' ? https : http;
    const request = client.request(endpoint, {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
        'Mcp-Session-Id': sessionId,
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      timeout: timeoutMs,
    }, (response) => {
      response.resume();
      response.on('end', resolve);
    });
    request.on('timeout', () => request.destroy(new Error('Session delete timed out.')));
    request.on('error', reject);
    request.end();
  });
}

function postJsonRpc(endpoint, body, { timeoutMs, sessionId, authToken }) {
  return new Promise((resolve, reject) => {
    const client = endpoint.protocol === 'https:' ? https : http;
    const request = client.request(
      endpoint,
      {
        method: 'POST',
        headers: {
          Accept: ACCEPT_HEADER,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
        },
        timeout: timeoutMs
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error(`HTTP request timed out after ${timeoutMs / 1000} seconds.`));
    });
    request.on('error', (error) => reject(gatewayUnavailable(endpoint, error.message)));
    request.end(body);
  });
}

function getJson(endpoint, { timeoutMs, authToken }) {
  return new Promise((resolve, reject) => {
    const client = endpoint.protocol === 'https:' ? https : http;
    const request = client.request(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
      timeout: timeoutMs
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = bodyText ? JSON.parse(bodyText) : null;
        } catch (error) {
          reject(gatewayUnavailable(endpoint, `Invalid Gateway JSON response: ${error.message}`));
          return;
        }
        resolve({ statusCode: response.statusCode || 0, body, text: bodyText });
      });
    });
    request.on('timeout', () => request.destroy(new Error(`HTTP request timed out after ${timeoutMs / 1000} seconds.`)));
    request.on('error', (error) => reject(gatewayUnavailable(endpoint, error.message)));
    request.end();
  });
}

function parseEndpoint(value, { defaultPath = '/' } = {}) {
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      return null;
    }
    if (!endpoint.pathname || endpoint.pathname === '/') {
      endpoint.pathname = defaultPath;
    }
    return endpoint;
  } catch (error) {
    return null;
  }
}

function gatewayUnavailable(endpoint, detail) {
  const error = new Error(detail || 'Gateway is unavailable.');
  error.code = 'GATEWAY_UNAVAILABLE';
  error.endpoint = endpoint;
  return error;
}

function formatGatewayUnavailable(error, endpoint) {
  const detail = error && error.code === 'GATEWAY_UNAVAILABLE'
    ? error.message
    : (error && error.message) || 'Gateway is unavailable.';
  const address = endpoint && endpoint.href ? endpoint.href : 'the configured Gateway';
  return `GATEWAY_UNAVAILABLE: ${detail} Central Gateway: ${address}. Open a Cocos Editor with the extension active.`;
}

function getRequestId(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return Object.prototype.hasOwnProperty.call(value, 'id') ? value.id : null;
}

function isNotification(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.method && !Object.prototype.hasOwnProperty.call(value, 'id'));
}

async function writeJsonRpcError(output, id, code, message) {
  await writeMessage(output, JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message
    }
  }));
}

async function readMessage(input) {
  const headers = new Map();

  while (true) {
    const line = await readHeaderLine(input);
    if (line === null) {
      return headers.size === 0 ? null : Promise.reject(new Error('Unexpected EOF while reading MCP headers.'));
    }

    if (line === '') {
      break;
    }

    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }

    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }

  const contentLength = Number.parseInt(headers.get('content-length') || '', 10);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    throw new Error('Missing Content-Length header.');
  }

  const payload = await readExact(input, contentLength);
  return payload.toString('utf8');
}

function readHeaderLine(input) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    function cleanup() {
      input.off('readable', onReadable);
      input.off('end', onEnd);
      input.off('error', onError);
    }

    function onReadable() {
      let byte;
      while ((byte = input.read(1)) !== null) {
        if (byte[0] === 0x0a) {
          cleanup();
          if (chunks.length > 0 && chunks[chunks.length - 1][0] === 0x0d) {
            chunks.pop();
          }
          resolve(Buffer.concat(chunks).toString('ascii'));
          return;
        }
        chunks.push(byte);
      }
    }

    function onEnd() {
      cleanup();
      resolve(chunks.length === 0 ? null : Buffer.concat(chunks).toString('ascii'));
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    input.on('readable', onReadable);
    input.once('end', onEnd);
    input.once('error', onError);
    onReadable();
  });
}

function readExact(input, length) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let remaining = length;

    function cleanup() {
      input.off('readable', onReadable);
      input.off('end', onEnd);
      input.off('error', onError);
    }

    function onReadable() {
      while (remaining > 0) {
        const chunk = input.read(remaining);
        if (chunk === null) {
          return;
        }
        chunks.push(chunk);
        remaining -= chunk.length;
      }
      cleanup();
      resolve(Buffer.concat(chunks, length));
    }

    function onEnd() {
      cleanup();
      reject(new Error('Unexpected EOF while reading MCP payload.'));
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    input.on('readable', onReadable);
    input.once('end', onEnd);
    input.once('error', onError);
    onReadable();
  });
}

function writeMessage(output, json) {
  const payload = Buffer.from(json, 'utf8');
  return new Promise((resolve, reject) => {
    output.write(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii', (headerError) => {
      if (headerError) {
        reject(headerError);
        return;
      }
      output.write(payload, (payloadError) => {
        if (payloadError) {
          reject(payloadError);
          return;
        }
        resolve();
      });
    });
  });
}

function hasFlag(args, name) {
  return args.some((arg) => arg.toLowerCase() === name.toLowerCase());
}

function getOption(args, name) {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i].toLowerCase() === name.toLowerCase()) {
      return args[i + 1];
    }
  }
  return '';
}

function readPackageVersion() {
  try {
    const packagePath = path.resolve(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return packageJson.version || '0.0.0';
  } catch (error) {
    return '0.0.0';
  }
}

function printHelp() {
  console.error('cocos-cli (funplay-cocos-mcp compatibility name)');
  console.error('Client-only CLI for the central Cocos Gateway.');
  console.error();
  console.error('Commands:');
  console.error('  mcp                              Bridge stdio MCP traffic (default).');
  console.error('  targets list                     List registered Editor targets.');
  console.error('  target health <targetId>         Show one registered target.');
  console.error('  call <tool> [json] [--target id] Call one tool through the Gateway.');
  console.error();
  console.error('Options:');
  console.error('  --url <http://127.0.0.1:8787/mcp> Central Gateway MCP endpoint.');
  console.error('  --timeout-seconds <120>           HTTP timeout per request.');
  console.error('  --token <value>                   Optional Gateway bearer token.');
  console.error('  --version                         Print the proxy version.');
  console.error('  --help                            Show this help.');
  console.error();
  console.error('Environment:');
  console.error('  FUNPLAY_COCOS_GATEWAY_URL');
  console.error('  FUNPLAY_COCOS_GATEWAY_TOKEN');
  console.error('  FUNPLAY_COCOS_MCP_URL');
  console.error('  FUNPLAY_COCOS_MCP_TIMEOUT_SECONDS');
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`[Funplay Cocos MCP] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  parseCommand,
  parseEndpoint,
  bridgeStdioToHttp,
};
