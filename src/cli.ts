#!/usr/bin/env node
import readline from "node:readline";
import { apiUrl, credentialsPath, loadCredential, removeCredential, resolveApiKey } from "./config";
import { defaultAgentName, pair } from "./pair";
import { handleLine } from "./proxy";

const HELP = `formward-mcp: Formward as an MCP server for your coding agent.

Usage:
  formward-mcp pair <CODE> [--name "Agent name"] [--api https://formward.eu]
      Claim a pairing code from Formward's dashboard (Connected agents), wait for
      the workspace owner to approve, store the resulting key for this user.
  formward-mcp                 Serve MCP over stdio (default; what your agent runs).
  formward-mcp status          Show which workspace is paired and when the key expires.
  formward-mcp logout          Forget the stored key for this API.

Environment:
  FORMWARD_API_KEY        Use this key instead of the paired one (CI, classic keys).
  FORMWARD_API_URL        API origin, default https://formward.eu.
  FORMWARD_AGENT_NAME     Name shown to the workspace owner when pairing.
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function printSetupHints(): void {
  process.stdout.write(`
Add Formward to your agent (any one of these):

  Claude Code:   claude mcp add formward -- npx -y @formward/mcp
  Codex CLI:     codex mcp add formward -- npx -y @formward/mcp
  Cursor / generic mcp.json:
    { "mcpServers": { "formward": { "command": "npx", "args": ["-y", "@formward/mcp"] } } }

Then ask the agent to create a form, paste the snippet and send a test submission.
`);
}

async function cmdPair(args: string[]): Promise<number> {
  const code = args.find((a) => !a.startsWith("--") && a !== flag(args, "--name") && a !== flag(args, "--api"));
  if (!code) {
    process.stderr.write("Missing pairing code. Create one under Dashboard > Connected agents.\n");
    return 2;
  }
  const api = apiUrl(flag(args, "--api"));
  const agentName = flag(args, "--name") ?? defaultAgentName();
  process.stderr.write(`Claiming code ${code} at ${api} as "${agentName}"...\n`);
  let last = "";
  const result = await pair({
    api,
    code,
    agentName,
    onStatus: (status) => {
      if (status !== last) {
        last = status;
        if (status === "claimed") process.stderr.write("Waiting for the workspace owner to approve in the dashboard...\n");
      }
    },
  });
  if (!result.ok) {
    process.stderr.write(`Pairing failed: ${result.reason}\n`);
    return 1;
  }
  process.stderr.write(`Paired with workspace "${result.workspace}". Key stored in ${result.file} (expires ${new Date(result.expiresAt).toLocaleDateString()}).\n`);
  printSetupHints();
  return 0;
}

async function cmdStatus(args: string[]): Promise<number> {
  const api = apiUrl(flag(args, "--api"));
  if (process.env.FORMWARD_API_KEY) {
    process.stdout.write(`Using FORMWARD_API_KEY from the environment against ${api}.\n`);
    return 0;
  }
  const stored = await loadCredential(api);
  if (!stored) {
    process.stdout.write(`Not paired with ${api}. Run: npx @formward/mcp pair <CODE>\n`);
    return 1;
  }
  const expired = new Date(stored.expiresAt).getTime() < Date.now();
  process.stdout.write(
    `Workspace: ${stored.workspace}\nAPI: ${api}\nPaired: ${stored.pairedAt}\nKey expires: ${stored.expiresAt}${expired ? " (expired: pair again)" : ""}\nFile: ${credentialsPath()}\n`,
  );
  return expired ? 1 : 0;
}

async function cmdLogout(args: string[]): Promise<number> {
  const api = apiUrl(flag(args, "--api"));
  const removed = await removeCredential(api);
  process.stdout.write(removed ? `Forgot the key for ${api}. Revoke it in the dashboard too if the machine is shared.\n` : `Nothing stored for ${api}.\n`);
  return 0;
}

async function cmdServe(args: string[]): Promise<number> {
  const api = apiUrl(flag(args, "--api"));
  const key = await resolveApiKey(api);
  if (!key) {
    process.stderr.write(
      `formward-mcp: no key for ${api}. Ask the workspace owner for a pairing code (Dashboard > Connected agents) and run:\n  npx @formward/mcp pair <CODE>\n`,
    );
    return 1;
  }
  if (key.expiresAt && new Date(key.expiresAt).getTime() < Date.now()) {
    process.stderr.write(`formward-mcp: the paired key expired on ${key.expiresAt}. Pair again with a fresh code.\n`);
    return 1;
  }
  const deps = { api, apiKey: key.apiKey, agentName: flag(args, "--name") ?? defaultAgentName() };

  // MCP stdio transport: newline-delimited JSON, one message per line, stdout
  // carries nothing but protocol messages. Replies are written in order.
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    queue = queue.then(async () => {
      try {
        const reply = await handleLine(line, deps);
        if (reply !== null) process.stdout.write(JSON.stringify(reply) + "\n");
      } catch (e) {
        // Last line of defence: a bug in one request must not end the session.
        process.stderr.write(`formward-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => rl.on("close", resolve));
  await queue;
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "serve":
      return cmdServe(cmd === undefined ? [] : rest);
    case "pair":
      return cmdPair(rest);
    case "status":
      return cmdStatus(rest);
    case "logout":
      return cmdLogout(rest);
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP);
      return 0;
    default:
      if (cmd.startsWith("--")) return cmdServe([cmd, ...rest]);
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

// Set the exit code and let the event loop drain: a process.exit() right after
// the last stdout.write() can truncate a reply larger than the pipe buffer.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`formward-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
