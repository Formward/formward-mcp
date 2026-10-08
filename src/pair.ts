import os from "node:os";
import { saveCredential } from "./config";

export interface PairOptions {
  api: string;
  code: string;
  agentName: string;
  /** Called on every poll with the current status, for progress output. */
  onStatus?: (status: string) => void;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export type PairResult =
  | { ok: true; workspace: string; expiresAt: string; file: string }
  | { ok: false; reason: string };

interface ClaimResponse {
  pairingId: string;
  pollToken: string;
  workspace: string;
  expiresAt: string;
  pollEveryMs?: number;
}

interface StatusResponse {
  status: "pending" | "claimed" | "approved" | "denied" | "expired";
  apiKey?: string;
  keyExpiresAt?: string;
  pollEveryMs?: number;
}

/** Guess a readable agent name from the environment when none is given. */
export function defaultAgentName(): string {
  if (process.env.FORMWARD_AGENT_NAME) return process.env.FORMWARD_AGENT_NAME;
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE) return "Claude Code";
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_AGENT) return "Cursor";
  if (process.env.CODEX_SANDBOX || process.env.CODEX_CLI) return "Codex";
  if (process.env.TERM_PROGRAM === "vscode") return "VS Code agent";
  return "MCP client";
}

/**
 * Device-style pairing: present the code the workspace owner created in the
 * dashboard, then poll until they approve or deny it. The key arrives exactly
 * once and is written to the credentials file; it is never printed.
 */
export async function pair(opts: PairOptions): Promise<PairResult> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const headers = { "content-type": "application/json", accept: "application/json", "user-agent": "formward-mcp" };
  const timeout = () => AbortSignal.timeout(15_000);

  let claim: ClaimResponse;
  try {
    const res = await f(`${opts.api}/api/agent-pairing/claim`, {
      method: "POST",
      headers,
      body: JSON.stringify({ code: opts.code, agent: { name: opts.agentName, host: os.hostname() } }),
      signal: timeout(),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<ClaimResponse> & { message?: string; error?: string };
    if (!res.ok || !body.pairingId || !body.pollToken) {
      return { ok: false, reason: body.message || `Pairing failed (${res.status}).` };
    }
    claim = body as ClaimResponse;
  } catch (e) {
    return { ok: false, reason: `Could not reach ${opts.api}: ${e instanceof Error ? e.message : String(e)}` };
  }

  const deadline = new Date(claim.expiresAt).getTime();
  let every = Math.max(1000, claim.pollEveryMs ?? 3000);
  while (Date.now() < deadline + 5000) {
    await sleep(every);
    let status: StatusResponse;
    try {
      const res = await f(`${opts.api}/api/agent-pairing/status`, {
        method: "POST",
        headers,
        body: JSON.stringify({ pairingId: claim.pairingId, pollToken: claim.pollToken }),
        signal: timeout(),
      });
      if (res.status === 429) {
        every = Math.min(every * 2, 15000);
        continue;
      }
      if (!res.ok) {
        if (res.status >= 500 || res.status === 408) continue; // transient: keep polling until the deadline
        // 400/401/404: this pairing cannot succeed; repeating the call would only run out the clock.
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        return { ok: false, reason: body.message || `Pairing status failed (${res.status}). Create a new code in the dashboard.` };
      }
      status = (await res.json()) as StatusResponse;
    } catch {
      continue; // transient network error: keep polling until the deadline
    }
    if (status.pollEveryMs) every = Math.max(1000, status.pollEveryMs);
    opts.onStatus?.(status.status);
    if (status.status === "approved" && status.apiKey) {
      const expiresAt = status.keyExpiresAt ?? new Date(Date.now() + 30 * 86400000).toISOString();
      const file = await saveCredential(opts.api, {
        apiKey: status.apiKey,
        workspace: claim.workspace,
        expiresAt,
        pairedAt: new Date().toISOString(),
      });
      return { ok: true, workspace: claim.workspace, expiresAt, file };
    }
    if (status.status === "approved") {
      return { ok: false, reason: "The key for this pairing was already collected. Create a new code in the dashboard." };
    }
    if (status.status === "denied") return { ok: false, reason: "The workspace owner denied this pairing." };
    if (status.status === "expired") return { ok: false, reason: "The pairing code expired before it was approved. Create a new one." };
  }
  return { ok: false, reason: "Timed out waiting for approval. Create a new code in the dashboard and try again." };
}
