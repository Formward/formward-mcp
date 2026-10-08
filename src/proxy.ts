/**
 * Stateless stdio-to-HTTP bridge. Every JSON-RPC message the MCP client writes
 * on stdin is POSTed to Formward's /api/v1/mcp with the paired key; the answer
 * is written back as one line. One tool is served locally because it has to run
 * from the developer's machine: send_test_submission posts to the form endpoint
 * the way the customer's website will.
 */

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
  apiKey: string;
  agentName: string;
  fetchImpl?: typeof fetch;
}

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

function rpcError(id: JsonRpcMessage["id"], message: string, code = -32000): JsonRpcMessage {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolResult(id: JsonRpcMessage["id"], text: string, isError = false): JsonRpcMessage {
  return { jsonrpc: "2.0", id: id ?? null, result: { content: [{ type: "text", text }], isError } };
}

export function parseLine(line: string): JsonRpcMessage | JsonRpcMessage[] | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed as JsonRpcMessage[];
    if (parsed && typeof parsed === "object") return parsed as JsonRpcMessage;
  } catch {
    // fall through
  }
  return { id: null, method: "__invalid__" };
}

/** Forward one message to the remote MCP endpoint. Returns null when there is nothing to write (notification). */
export async function forward(msg: JsonRpcMessage, deps: ProxyDeps): Promise<JsonRpcMessage | null> {
  const f = deps.fetchImpl ?? fetch;
  const id = msg.id;
  const isNotification = msg.id === undefined;
  let res: Response;
  let text: string;
  try {
    res = await f(`${deps.api}/api/v1/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": `formward-mcp (${deps.agentName})`,
      },
      body: JSON.stringify(msg),
    });
    // The body read can fail after fetch() resolved (connection dropped mid
    // response); that is the same per-request error as an unreachable host.
    text = await res.text();
  } catch (e) {
    if (isNotification) return null;
    return rpcError(id, `Could not reach ${deps.api}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 202 || !text) return null;
  if (!res.ok) {
    if (isNotification) return null;
    let detail = text;
    try {
      const body = JSON.parse(text) as { error?: { message?: string; code?: string } };
      detail = body.error?.message ?? text;
      if (res.status === 401) detail += " The paired key may have expired or been revoked: run `npx @formward/mcp pair <code>` with a fresh code from the dashboard.";
    } catch {
      // keep raw text
    }
    return rpcError(id, `Formward API ${res.status}: ${detail}`);
  }
  try {
    return JSON.parse(text) as JsonRpcMessage;
  } catch {
    return rpcError(id, "Formward API returned a non-JSON response.");
  }
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
  const result = reply.result as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;
  const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
  let body: { data?: FormListItem[] };
  try {
    body = JSON.parse(text) as { data?: FormListItem[] };
  } catch {
    return { error: `Could not list forms: ${result?.isError ? text.slice(0, 300) : "unexpected response"}` };
  }
  if (result?.isError) return { error: `Could not list forms: ${text.slice(0, 300)}` };
  const form = Array.isArray(body?.data) ? body.data.find((item) => item.id === formId) : undefined;
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
  try {
    res = await f(found.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": `formward-mcp (${deps.agentName})` },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { text: `Could not reach ${found.endpoint}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
  const text = await res.text();
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

/** One message: local tool, or forwarded with the local tool spliced into tools/list. */
async function handleOne(msg: JsonRpcMessage, deps: ProxyDeps): Promise<JsonRpcMessage | null> {
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
  if (msg.method === "__invalid__") return rpcError(null, "Parse error", -32700);
  return handleOne(msg, deps);
}
