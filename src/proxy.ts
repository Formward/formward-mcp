/**
 * Stateless stdio-to-HTTP bridge. Every JSON-RPC message the MCP client writes
 * on stdin is POSTed to Formward's /api/v1/mcp with the paired key; the answer
 * is written back as one line. One tool is served locally because it has to run
 * from the developer's machine: send_test_submission posts to the form endpoint
 * the way the customer's website will.
 */

import tools from "./tools.json";

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export interface ProxyDeps {
  api: string;
  /** null until the user has paired (or set FORMWARD_API_KEY): see handleUnpaired. */
  apiKey: string | null;
  agentName: string;
  fetchImpl?: typeof fetch;
  /**
   * Re-read the stored key, so a `pair` run in another terminal reaches this
   * server without a restart (checked on every 401 and while unpaired).
   * Absent when the key comes from FORMWARD_API_KEY, which takes precedence.
   */
  reloadKey?: () => Promise<string | null>;
}

const PKG_VERSION = (require("../package.json") as { version: string }).version;

/** Protocol revisions the backend speaks, newest first (mirrors the server). */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const UNPAIRED_INSTRUCTIONS =
  "Formward is not paired on this machine yet, so every tool call answers with these instructions. " +
  "Ask the workspace owner for a pairing code (Formward dashboard > Connected agents), run " +
  "`npx @formward/mcp pair <CODE>` in a terminal, then restart this MCP server.";

/** Upper bound for one HTTP round trip, so a stalled connection becomes an error instead of a hung request. */
export const REQUEST_TIMEOUT_MS = 30_000;

export const TEST_TOOL = {
  name: "send_test_submission",
  description:
    "Send one test submission to a form's endpoint from this machine, exactly like the website will " +
    "(JSON body, Accept: application/json). Counts as one submission against the plan. Then call " +
    "get_form_stats to confirm it arrived; the dashboard shows the content. Pass `values` matching the " +
    "form's fields (include `_consent: \"on\"` for consent-gated forms), or omit it for name/email/message " +
    "defaults. The honeypot and redirect controls are always stripped.",
  inputSchema: {
    type: "object",
    properties: {
      formId: { type: "string" },
      values: { type: "object", description: "Field name to value. Defaults to name, email and message." },
    },
    required: ["formId"],
    additionalProperties: false,
  },
};

/**
 * The display name goes to the server as JSON when pairing; in headers it has
 * to be a plain ASCII token or Node's fetch refuses to build the request.
 */
export function headerSafeName(name: string): string {
  const cleaned = name.replace(/[^\x20-\x7e]/g, "").replace(/[()\\]/g, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "agent";
}

function rpcError(id: JsonRpcMessage["id"], message: string, code = -32000): JsonRpcMessage {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolResult(id: JsonRpcMessage["id"], text: string, isError = false): JsonRpcMessage {
  return { jsonrpc: "2.0", id: id ?? null, result: { content: [{ type: "text", text }], isError } };
}

/**
 * Parse one stdio line. Malformed JSON is a parse error (-32700); valid JSON
 * that is not an object or array (null, a number, a string) is a valid parse
 * but an invalid request (-32600), as the JSON-RPC spec distinguishes them.
 */
export function parseLine(line: string): JsonRpcMessage | JsonRpcMessage[] | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { id: null, method: "__parse_error__" };
  }
  if (Array.isArray(parsed)) return parsed as JsonRpcMessage[];
  if (parsed && typeof parsed === "object") return parsed as JsonRpcMessage;
  return { id: null, method: "__invalid_request__" };
}

/** Forward one message to the remote MCP endpoint. Returns null when there is nothing to write (notification). */
export async function forward(msg: JsonRpcMessage, deps: ProxyDeps, retried = false): Promise<JsonRpcMessage | null> {
  const f = deps.fetchImpl ?? fetch;
  const id = msg.id;
  const isNotification = msg.id === undefined;
  // The key this request goes out with. Batch elements run concurrently, so
  // by the time a 401 comes back another element may already have reloaded
  // deps.apiKey; the retry decision compares against what THIS request used.
  const usedKey = deps.apiKey;
  let res: Response;
  let text: string;
  try {
    res = await f(`${deps.api}/api/v1/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${usedKey}`,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": `formward-mcp (${headerSafeName(deps.agentName)})`,
      },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // The body read can fail after fetch() resolved (connection dropped mid
    // response); that is the same per-request error as an unreachable host.
    text = await res.text();
  } catch (e) {
    if (isNotification) return null;
    return rpcError(id, `Could not reach ${deps.api}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // A failure is answered even when its body is empty (a proxy's bare 401/502):
  // only a successful empty reply means "notification accepted".
  if (!res.ok) {
    // A rejected key may have been replaced by a `pair` run since this server
    // started: retry once with the stored key if it changed.
    if (res.status === 401 && !retried && deps.reloadKey) {
      const fresh = await deps.reloadKey();
      if (fresh && fresh !== usedKey) {
        deps.apiKey = fresh;
        return forward(msg, deps, true);
      }
    }
    if (isNotification) return null;
    let detail = text || res.statusText || "empty response";
    try {
      const body = JSON.parse(text) as { error?: { message?: string; code?: string } };
      detail = body.error?.message ?? detail;
    } catch {
      // keep raw text
    }
    // The recovery hint depends on the status, not on whether the body parsed.
    if (res.status === 401) {
      detail += deps.reloadKey
        ? " The paired key may have expired or been revoked: run `npx @formward/mcp pair <code>` with a fresh code from the dashboard; this server picks the new key up on its next request."
        : " FORMWARD_API_KEY is set and takes precedence over a paired key: update or unset it, then restart this server.";
    }
    return rpcError(id, `Formward API ${res.status}: ${detail}`);
  }
  // A successful empty reply is right for a notification (202) and wrong for a
  // request, which must always get an answer or the client waits for nothing.
  if (res.status === 202 || !text) {
    return isNotification ? null : rpcError(id, `Formward API ${res.status}: empty response to a request.`);
  }
  // Valid JSON of the wrong shape (null, an array, a string) must not pass
  // through as the reply: a null would read as "nothing to write" and leave
  // the client waiting for an answer that never comes.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return rpcError(id, "Formward API returned a non-JSON response.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return rpcError(id, "Formward API returned a response that is not a JSON-RPC message.");
  }
  return parsed as JsonRpcMessage;
}

interface FormListItem {
  id: string;
  name?: string;
  endpoint: string;
}

/**
 * Resolve the form's endpoint through the MCP endpoint's own list_forms tool,
 * so it works for every key that can use this server at all (a paired key on
 * the Free plan included) and never depends on the plain REST API's plan gate.
 */
async function lookupEndpoint(formId: string, deps: ProxyDeps): Promise<FormListItem | { error: string }> {
  let reply: JsonRpcMessage | null;
  try {
    reply = await forward({ jsonrpc: "2.0", id: "lookup", method: "tools/call", params: { name: "list_forms", arguments: {} } }, deps);
  } catch (e) {
    // Network or decoding failure is a tool error, never an unhandled rejection
    // that would take the stdio session down with it.
    return { error: `Could not list forms: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!reply) return { error: "Could not list forms: empty response." };
  if (reply.error) return { error: `Could not list forms: ${(reply.error as { message?: string }).message ?? "error"}` };
  const result = reply.result as { content?: unknown; isError?: boolean } | undefined;
  const content = Array.isArray(result?.content) ? (result.content as { type?: string; text?: string }[]) : [];
  const text = content.find((c) => c && c.type === "text" && typeof c.text === "string")?.text ?? "";
  let body: { data?: FormListItem[] };
  try {
    body = JSON.parse(text) as { data?: FormListItem[] };
  } catch {
    return { error: `Could not list forms: ${result?.isError ? text.slice(0, 300) : "unexpected response"}` };
  }
  if (result?.isError) return { error: `Could not list forms: ${text.slice(0, 300)}` };
  // Entries are checked one by one: a malformed element must not throw out of
  // the tool (the stdio loop would only log it and the client would wait).
  const form = Array.isArray(body?.data)
    ? body.data.find((item) => item && typeof item === "object" && item.id === formId && typeof item.endpoint === "string")
    : undefined;
  return form ?? { error: `No form ${formId} in this workspace. Call list_forms first.` };
}

export async function sendTestSubmission(args: Record<string, unknown>, deps: ProxyDeps): Promise<{ text: string; isError: boolean }> {
  const formId = typeof args.formId === "string" ? args.formId.trim() : "";
  if (!formId) return { text: "formId is required.", isError: true };
  const found = await lookupEndpoint(formId, deps);
  if ("error" in found) return { text: found.error, isError: true };

  const stamp = new Date().toISOString();
  const defaults = {
    name: `Test from ${deps.agentName}`,
    email: "test@example.com",
    message: `Test submission sent by ${deps.agentName} via @formward/mcp at ${stamp}.`,
  };
  const given = args.values && typeof args.values === "object" && !Array.isArray(args.values) ? (args.values as Record<string, unknown>) : null;
  const payload: Record<string, unknown> = given && Object.keys(given).length > 0 ? { ...given } : { ...defaults };
  // A test must never trip the honeypot or redirect anywhere. Other control
  // fields (_consent for consent-gated forms, _subject, _replyto) stay, so a
  // test can mirror what the real form sends.
  for (const key of ["_gotcha", "_redirect", "_next"]) delete payload[key];

  const f = deps.fetchImpl ?? fetch;
  let res: Response;
  let text: string;
  try {
    res = await f(found.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": `formward-mcp (${headerSafeName(deps.agentName)})` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    return { text: `Could not reach ${found.endpoint}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
  const summary = {
    endpoint: found.endpoint,
    status: res.status,
    response: safeJson(text),
    sent: Object.keys(payload),
    hint:
      res.status === 200
        ? "Accepted. Call get_form_stats to see the count go up; the owner finds the content in the dashboard inbox."
        : res.status === 403
          ? "Rejected. If the form has allowed origins set, requests without a matching Origin header are refused: test from the website itself, or clear allowed origins while testing."
          : res.status === 429
            ? "Rate limited or over quota."
            : "See response for the error code; /docs/responses explains each one.",
  };
  return { text: JSON.stringify(summary, null, 2), isError: res.status >= 400 };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}

/**
 * A well-formed JSON-RPC 2.0 request or notification (the backend validates
 * forwarded ones; local handling must too). `params` may be an object or an
 * array, as JSON-RPC allows; the backend treats an array as no parameters.
 */
function isValidRequest(msg: JsonRpcMessage): boolean {
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return false;
  if (msg.id !== undefined && msg.id !== null && typeof msg.id !== "string" && typeof msg.id !== "number") return false;
  return msg.params === undefined || (typeof msg.params === "object" && msg.params !== null);
}

/**
 * Without a key the server still speaks MCP: a client can register it before
 * pairing, directory checks can introspect it, and a coding agent that calls
 * a tool gets told how to pair instead of a dead process. The tool list is a
 * built-in copy of the backend's (kept equal by a test in the monorepo), so
 * nothing here touches the network.
 */
function handleUnpaired(msg: JsonRpcMessage): JsonRpcMessage | null {
  const id = msg.id;
  const method = msg.method ?? "";
  if (method.startsWith("notifications/")) return null;
  if (id === undefined) return null;
  switch (method) {
    case "initialize": {
      const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "formward", version: PKG_VERSION },
          instructions: UNPAIRED_INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: [...tools, TEST_TOOL] } };
    case "tools/call":
      return toolResult(id, UNPAIRED_INSTRUCTIONS, true);
    default:
      return rpcError(id, `Method not found: ${method}`, -32601);
  }
}

/** One message: local tool, or forwarded with the local tool spliced into tools/list. */
async function handleOne(msg: JsonRpcMessage, deps: ProxyDeps): Promise<JsonRpcMessage | null> {
  // Only a well-formed notification is silent; a malformed object without an
  // id is still answered (with a null id), as the backend does. An id of an
  // invalid type is replaced by null so the error reply itself stays valid.
  if (!isValidRequest(msg)) {
    const id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
    return rpcError(id, "Invalid Request", -32600);
  }
  if (deps.apiKey === null && deps.reloadKey) {
    // Pairing may have completed since this server started.
    const fresh = await deps.reloadKey();
    if (fresh) deps.apiKey = fresh;
  }
  if (deps.apiKey === null) return handleUnpaired(msg);
  if (msg.method === "tools/call" && msg.params?.name === TEST_TOOL.name) {
    const args = (msg.params.arguments ?? {}) as Record<string, unknown>;
    const out = await sendTestSubmission(args, deps);
    return msg.id === undefined ? null : toolResult(msg.id, out.text, out.isError);
  }
  const reply = await forward(msg, deps);
  if (msg.method === "tools/list" && reply?.result && typeof reply.result === "object") {
    const result = reply.result as { tools?: unknown[] };
    if (Array.isArray(result.tools)) result.tools = [...result.tools, TEST_TOOL];
  }
  return reply;
}

/**
 * Handle one incoming line. Returns the message(s) to write back, or null.
 * A JSON-RPC batch is handled element by element (so local tools work inside
 * it too) and answered as a batch of the non-notification replies.
 */
export async function handleLine(line: string, deps: ProxyDeps): Promise<JsonRpcMessage | JsonRpcMessage[] | null> {
  const msg = parseLine(line);
  if (msg === null) return null;
  if (Array.isArray(msg)) {
    if (msg.length === 0) return rpcError(null, "Invalid Request", -32600);
    const replies = await Promise.all(msg.map((m) => (m && typeof m === "object" ? handleOne(m, deps) : Promise.resolve(rpcError(null, "Invalid Request", -32600)))));
    const out = replies.filter((r): r is JsonRpcMessage => r !== null);
    return out.length > 0 ? out : null;
  }
  if (msg.method === "__parse_error__") return rpcError(null, "Parse error", -32700);
  if (msg.method === "__invalid_request__") return rpcError(null, "Invalid Request", -32600);
  return handleOne(msg, deps);
}
