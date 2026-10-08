# @formward/mcp

Formward as an MCP server for your coding agent. Pair once from the Formward dashboard, then let Claude Code, Codex, Cursor or any other MCP client create forms, fetch the paste-ready snippet, add webhooks and confirm a test submission against your workspace.

Formward is a form backend hosted in the EU (Sweden). This package talks to it over HTTPS with a key that is pinned to one workspace and can never read what your visitors submitted.

## Pairing

1. In Formward, open **Dashboard > Connected agents** and create a pairing code. Codes are single use and expire after 10 minutes.
2. In your project, run:

```sh
npx @formward/mcp pair ABCD-EFGH
```

3. Approve the claim in the dashboard. The CLI stores the key for your user (never printed) and shows how to register the server:

```sh
claude mcp add formward -- npx -y @formward/mcp      # Claude Code
codex mcp add formward -- npx -y @formward/mcp       # Codex CLI
```

```json
{ "mcpServers": { "formward": { "command": "npx", "args": ["-y", "@formward/mcp"] } } }
```

The key lives for 30 days and can be revoked in the dashboard at any time. Pairing works on every plan, including Free; the forms the agent creates follow your plan's limits like any other form.

## What the agent can do

| Tool | What it does |
| --- | --- |
| `list_forms` | Forms in the workspace with endpoint and hosted page URLs |
| `list_templates` | Field lists of the built-in templates |
| `create_form` | Create a form from fields or a template, optionally with a hosted page |
| `get_form_snippet` | Paste-ready markup for html, react, vue, svelte, astro, nextjs, nuxt, tailwind, shopify or webflow |
| `get_form_stats` | Submission counts and the time of the latest one, nothing else |
| `list_webhooks`, `add_webhook` | Webhook destinations (Professional plan and above) |
| `send_test_submission` | Posts one test submission to the form endpoint from your machine |

The agent never sees submission content. After a test it checks the count with `get_form_stats`; you read the message in the dashboard.

Before pairing, the server still starts: it answers `initialize` and `tools/list` from a built-in copy of the tool list, and every tool call returns the pairing instructions. So you can register it in your agent first and pair when the owner has a code ready.

## Commands

```
formward-mcp pair <CODE> [--name "Agent name"]   claim a code and wait for approval
formward-mcp                                      serve MCP over stdio (what the agent runs)
formward-mcp status                               paired workspace and key expiry
formward-mcp logout                               forget the stored key
```

Environment: `FORMWARD_API_KEY` uses a key directly (CI, or a classic Professional API key) and takes precedence over a paired key, `FORMWARD_API_URL` points at another API origin, `FORMWARD_AGENT_NAME` sets the name the workspace owner sees.

A running server re-reads the stored key when the API rejects the current one and while it is unpaired, so pairing again (or for the first time) in another terminal takes effect without a restart.

Credentials are stored in `~/.config/formward/credentials.json` (`%APPDATA%\formward\credentials.json` on Windows), readable by your user only.

## How it works

The server is a stateless stdio bridge: each JSON-RPC message from the client is forwarded to `https://formward.eu/api/v1/mcp` with your key, and the answer is written back. Only `send_test_submission` runs locally, because the test should come from the machine that will host the website.

No dependencies beyond Node.js 18.17 or newer.

## Development

```sh
npm install
npm test
```

A Dockerfile is included for directory checks: `docker build -t formward-mcp . && docker run -i --rm formward-mcp`.

## License

MIT. See LICENSE.
