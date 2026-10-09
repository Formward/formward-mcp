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

function isClaimResponse(v: unknown): v is ClaimResponse {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.pairingId === "string" && c.pairingId.length > 0 &&
    typeof c.pollToken === "string" && c.pollToken.length > 0 &&
    typeof c.workspace === "string" &&
    typeof c.expiresAt === "string" && Number.isFinite(new Date(c.expiresAt).getTime()) &&
    (c.pollEveryMs === undefined || (typeof c.pollEveryMs === "number" && Number.isFinite(c.pollEveryMs)))
  );
}

const STATUSES: readonly StatusResponse["status"][] = ["pending", "claimed", "approved", "denied", "expired"];

/** A status payload with every field in its declared type; the key is only ever stored from one of these. */
function isStatusResponse(v: unknown): v is StatusResponse {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  if (!STATUSES.includes(s.status as StatusResponse["status"])) return false;
  if (s.apiKey !== undefined && (typeof s.apiKey !== "string" || s.apiKey.length === 0)) return false;
  if (s.keyExpiresAt !== undefined && typeof s.keyExpiresAt !== "string") return false;
  if (s.pollEveryMs !== undefined && typeof s.pollEveryMs !== "number") return false;
  return true;
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
    const body: unknown = await res.json().catch(() => ({}));
    const message = body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string" ? (body as { message: string }).message : "";
    if (!res.ok) return { ok: false, reason: message || `Pairing failed (${res.status}).` };
    // Every field the poll loop depends on must have its declared type: a
    // non-numeric pollEveryMs would make the loop spin, a bad expiresAt an
    // immediate timeout, a non-string workspace a corrupt credential.
    if (!isClaimResponse(body)) return { ok: false, reason: `Pairing failed: unexpected response from ${opts.api}.` };
    claim = body;
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
      const body: unknown = await res.json();
      // A 200 with a body that is not a status object (null, a string, a
      // proxy's HTML-as-JSON, an unknown status, a non-string key) is as
      // transient as a dropped connection: nothing from it gets stored.
      if (!isStatusResponse(body)) continue;
      status = body;
    } catch {
      continue; // transient network error or non-JSON body: keep polling until the deadline
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
