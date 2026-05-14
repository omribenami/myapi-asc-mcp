# myapi-asc-mcp

MCP server for [MyApi](https://www.myapiai.com) — connects AI agents using **ASC (Agentic Secure Connection)**, the most secure authentication method.

**What it does automatically:**
- Generates a unique Ed25519 keypair for this agent on first run
- Registers the key with MyApi and asks the user for a one-time approval
- Signs every API request cryptographically — no IP or User-Agent tracking, no false-positive alerts when workers rotate or IPs change

---

## Setup (for humans)

**Step 1 — Get a MyApi token**

Go to [MyApi → Access Tokens](https://www.myapiai.com/dashboard/access-tokens) and copy any token with the scope you need.

**Step 2 — Add to your MCP config**

For **Claude Code** (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "myapi": {
      "command": "npx",
      "args": ["-y", "myapi-asc-mcp"],
      "env": {
        "MYAPI_TOKEN": "myapi_your_token_here"
      }
    }
  }
}
```

For **Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "myapi": {
      "command": "npx",
      "args": ["-y", "myapi-asc-mcp"],
      "env": {
        "MYAPI_TOKEN": "myapi_your_token_here"
      }
    }
  }
}
```

**Step 3 — Restart your agent, then call `myapi_status`**

The server will generate a keypair, register it, and give you a fingerprint to approve in [MyApi → Devices](https://www.myapiai.com/dashboard/devices). Click Approve, call `myapi_status` again — done.

---

## Setup (for AI agents reading this)

You are an AI agent. Here is exactly what to do to connect to MyApi:

1. **Check if the MCP server is configured.** Look for `myapi_status` in your available tools.
   - If it is there: call `myapi_status` now.
   - If it is not there: tell the user to add the MCP config above and restart you.

2. **Call `myapi_status`.** It will respond with one of:
   - ✓ Connected → you're ready, proceed to use other `myapi_*` tools.
   - ⏳ Pending approval → relay the fingerprint and approval URL to the user exactly as given. Wait for them to approve, then call `myapi_status` again.
   - ⚠️ Token missing → ask the user for their `MYAPI_TOKEN` from Access Tokens and add it to the MCP config.

3. **Never try to implement Ed25519 signing yourself.** This MCP server handles all signing automatically. Just call the tools.

---

## Available tools

| Tool | When to use |
|------|-------------|
| `myapi_status` | Always call first. Handles setup + confirms the connection is active. |
| `myapi_identity` | Fetch the user's name, email, and personas. Good for verifying the connection works. |

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MYAPI_TOKEN` | ✓ | — | Bearer token from [Access Tokens](https://www.myapiai.com/dashboard/access-tokens) |
| `MYAPI_BASE_URL` | — | `https://www.myapiai.com` | Override for dev: `https://dev.myapiai.com` |

---

## How it works

The private key is generated once and stored at `~/.myapi/asc-mcp.json` (mode 600 — only your user can read it). It never leaves that file. Every API request is signed with a timestamp, so even if the bearer token leaks, an attacker cannot forge requests without the private key.

```
First run:
  generate keypair → register public key → user approves in dashboard → ready

Every request:
  sign(timestamp:tokenId, privateKey) → X-Agent-Signature header → server verifies
```

---

## License

MIT
