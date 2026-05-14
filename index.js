#!/usr/bin/env node
'use strict';

const { Server }               = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ── Config ───────────────────────────────────────────────────────────────────

const BASE_URL = (process.env.MYAPI_BASE_URL || 'https://www.myapiai.com').replace(/\/$/, '');
const BEARER   = process.env.MYAPI_TOKEN || '';
const KEY_FILE = path.join(os.homedir(), '.myapi', 'asc-mcp.json');
const LABEL    = `myapi-asc-mcp (${os.hostname()})`;

// ── Key management ───────────────────────────────────────────────────────────

function loadKey() {
  try { return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')); } catch { return null; }
}

function generateAndSaveKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPub  = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  const privPem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  const keyData = { publicKey: rawPub, privateKey: privPem, tokenId: null, approved: false };
  fs.writeFileSync(KEY_FILE, JSON.stringify(keyData, null, 2), { mode: 0o600 });
  return keyData;
}

function saveKey(keyData) {
  fs.writeFileSync(KEY_FILE, JSON.stringify(keyData, null, 2), { mode: 0o600 });
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function buildHeaders(keyData) {
  const ts  = String(Math.floor(Date.now() / 1000));
  const sig = crypto.sign(
    null,
    Buffer.from(`${ts}:${keyData.tokenId}`),
    crypto.createPrivateKey(keyData.privateKey)
  ).toString('base64');
  return {
    'Authorization':     `Bearer ${BEARER}`,
    'X-Agent-PublicKey': keyData.publicKey,
    'X-Agent-Signature': sig,
    'X-Agent-Timestamp': ts,
    'Content-Type':      'application/json',
  };
}

async function api(method, endpoint, body, signed = false, keyData = null) {
  const headers = signed && keyData?.tokenId
    ? buildHeaders(keyData)
    : { 'Authorization': `Bearer ${BEARER}`, 'Content-Type': 'application/json' };
  const res  = await fetch(`${BASE_URL}/api/v1${endpoint}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function text(str) {
  return { content: [{ type: 'text', text: String(str) }] };
}

// ── Setup ─────────────────────────────────────────────────────────────────────
// Returns { ready: true, keyData } or { ready: false, message }

async function ensureReady() {
  if (!BEARER) return {
    ready: false,
    message: '⚠️  MYAPI_TOKEN is not set.\n\nAdd it to your MCP config:\n  "env": { "MYAPI_TOKEN": "myapi_..." }\n\nGet your token at: ' + BASE_URL + '/dashboard/access-tokens',
  };

  let keyData = loadKey() || generateAndSaveKey();

  // Fetch tokenId if missing
  if (!keyData.tokenId) {
    const r = await api('GET', '/agentic/asc/token-id');
    if (!r.ok) return { ready: false, message: `⚠️  Cannot reach MyApi (HTTP ${r.status}). Check MYAPI_TOKEN and MYAPI_BASE_URL.` };
    keyData.tokenId = r.data.tokenId;
    saveKey(keyData);
  }

  // Already approved — fast path
  if (keyData.approved) return { ready: true, keyData };

  // Probe with a signed request
  const probe = await api('GET', '/identity', null, true, keyData);
  if (probe.ok) {
    keyData.approved = true;
    saveKey(keyData);
    return { ready: true, keyData };
  }

  // 403 → pending — register so it shows with a label in Devices
  if (probe.status === 403) {
    await api('POST', '/agentic/asc/register', { public_key: keyData.publicKey, label: LABEL });
    const fp = (await api('POST', '/agentic/asc/register', { public_key: keyData.publicKey, label: LABEL })).data?.key_fingerprint || '(see Devices page)';
    return {
      ready: false,
      message: [
        '⏳ One-time approval needed.',
        '',
        `I've registered my public key with MyApi.`,
        `Fingerprint: ${fp}`,
        '',
        `Please open: ${BASE_URL}/dashboard/devices`,
        `and click Approve on the entry called "${LABEL}".`,
        '',
        `Then call myapi_status again — I'll confirm automatically.`,
      ].join('\n'),
    };
  }

  return { ready: false, message: `⚠️  Unexpected response (HTTP ${probe.status}). Check your token.` };
}

// ── MCP server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'myapi-asc-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'myapi_status',
      description: [
        'Check the MyApi ASC connection status.',
        'ALWAYS call this first before any other myapi_* tool.',
        'On first run it generates a keypair, registers it with MyApi, and asks the user to approve it in the Devices dashboard (one-time, takes ~10 seconds).',
        'Once approved, all requests are signed automatically and this returns a confirmation.',
      ].join(' '),
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'myapi_identity',
      description: "Fetch the user's MyApi identity: display name, email, and active personas. Use this to verify the connection is working or to understand who the user is.",
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === 'myapi_status') {
    const result = await ensureReady();
    if (!result.ready) return text(result.message);
    const { keyData } = result;
    return text([
      '✓ MyApi ASC connection active.',
      `  Signing key: ${keyData.publicKey.slice(0, 16)}…`,
      `  Key file:    ${KEY_FILE}`,
      '',
      'You can now call myapi_identity or any other myapi_* tool.',
    ].join('\n'));
  }

  if (name === 'myapi_identity') {
    const result = await ensureReady();
    if (!result.ready) return text(`Not connected. Call myapi_status first.\n\n${result.message}`);
    const res = await api('GET', '/identity', null, true, result.keyData);
    if (!res.ok) return text(`Error ${res.status}: ${JSON.stringify(res.data)}`);
    return text(JSON.stringify(res.data, null, 2));
  }

  return text(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
