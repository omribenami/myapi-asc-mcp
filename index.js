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
const KEY_FILE = path.join(os.homedir(), '.myapi', 'asc-mcp.json');

// ── Key management ───────────────────────────────────────────────────────────

function loadKey() {
  try { return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')); } catch { return null; }
}

function generateAndSaveKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPub    = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const rawPubB64 = rawPub.toString('base64');
  const privPem   = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const fingerprint = crypto.createHash('sha256').update(rawPubB64).digest('hex').substring(0, 32);
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  const keyData = { publicKey: rawPubB64, privateKey: privPem, fingerprint, approved: false };
  fs.writeFileSync(KEY_FILE, JSON.stringify(keyData, null, 2), { mode: 0o600 });
  return keyData;
}

function saveKey(keyData) {
  fs.writeFileSync(KEY_FILE, JSON.stringify(keyData, null, 2), { mode: 0o600 });
}

// ── HTTP — signed with Ed25519, no bearer token ───────────────────────────────

function ascHeaders(keyData) {
  const ts  = String(Math.floor(Date.now() / 1000));
  const msg = Buffer.from(`${ts}:${keyData.fingerprint}`);
  const sig = crypto.sign(null, msg, crypto.createPrivateKey(keyData.privateKey)).toString('base64');
  return {
    'X-Agent-PublicKey':  keyData.publicKey,
    'X-Agent-Signature':  sig,
    'X-Agent-Timestamp':  ts,
    'Content-Type':       'application/json',
  };
}

async function api(method, endpoint, body, keyData) {
  const headers = keyData
    ? ascHeaders(keyData)
    : { 'Content-Type': 'application/json' };
  const res  = await fetch(`${BASE_URL}/api/v1${endpoint}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function text(str) {
  return { content: [{ type: 'text', text: String(str) }] };
}

// ── Status check ──────────────────────────────────────────────────────────────

async function checkStatus(keyData) {
  const probe = await api('GET', '/identity', null, keyData);
  if (probe.ok) return { approved: true };
  if (probe.status === 401) return { approved: false, reason: 'not_registered' };
  if (probe.status === 403) return { approved: false, reason: 'pending' };
  return { approved: false, reason: `error_${probe.status}` };
}

// ── MCP server ────────────────────────────────────────────────────────────────

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
        'On first run it generates an Ed25519 keypair and outputs the public key for the user to register in the MyApi dashboard.',
        'Once the user has registered and approved the key, this confirms the connection is active.',
      ].join(' '),
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'myapi_identity',
      description: "Fetch the user's MyApi identity (name, email, active personas). Use this to confirm the connection is working.",
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === 'myapi_status') {
    let keyData = loadKey() || generateAndSaveKey();

    if (!keyData.approved) {
      const { approved, reason } = await checkStatus(keyData);
      if (approved) {
        keyData.approved = true;
        saveKey(keyData);
      } else if (reason === 'not_registered') {
        return text([
          '🔑 First-time setup — register this public key with the user.',
          '',
          `Public key (Ed25519):`,
          keyData.publicKey,
          '',
          `Key file: ${KEY_FILE}`,
          '',
          'Ask the user to:',
          `  1. Go to ${BASE_URL}/dashboard/connectors → Agent Connections → ASC Keypair`,
          '  2. Paste the public key above into the registration form',
          '  3. Click "Register public key"',
          '  4. Approve the pending entry in the Devices page',
          '',
          'Then call myapi_status again — I will confirm automatically.',
        ].join('\n'));
      } else if (reason === 'pending') {
        return text([
          '⏳ Key registered — waiting for approval.',
          '',
          `Ask the user to open ${BASE_URL}/dashboard/devices and click Approve.`,
          'Then call myapi_status again.',
        ].join('\n'));
      } else {
        return text(`⚠️  Unexpected response from MyApi (${reason}). Check MYAPI_BASE_URL or try again.`);
      }
    }

    return text([
      '✓ MyApi ASC connection active.',
      `  Key fingerprint: ${keyData.fingerprint}`,
      `  Key file:        ${KEY_FILE}`,
      '',
      'All requests are signed cryptographically. You can now call myapi_identity or any other myapi_* tool.',
    ].join('\n'));
  }

  if (name === 'myapi_identity') {
    let keyData = loadKey();
    if (!keyData?.approved) {
      return text('Not connected. Call myapi_status first to complete setup.');
    }
    const res = await api('GET', '/identity', null, keyData);
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
