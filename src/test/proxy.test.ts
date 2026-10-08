import { test } from "node:test";
import assert from "node:assert/strict";
import { handleLine, TEST_TOOL, type JsonRpcMessage } from "../proxy";

type Call = { url: string; init?: RequestInit };

function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>, calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const match = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!match) return new Response("not found", { status: 404 });
    return routes[match](init);
  }) as typeof fetch;
}

const deps = (fetchImpl: typeof fetch) => ({ api: "https://app.test", apiKey: "fwk_live_x", agentName: "Test agent", fetchImpl });

test("forwards a request, carries the key and appends the local tool to tools/list", async () => {
  const calls: Call[] = [];
  const f = fakeFetch(
    {
      "https://app.test/api/v1/mcp": () =>
        Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "list_forms", description: "", inputSchema: {} }] } }),
    },
    calls,
  );
  const reply = (await handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), deps(f))) as JsonRpcMessage;
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, "Bearer fwk_live_x");
  const tools = (reply.result as { tools: { name: string }[] }).tools.map((t) => t.name);
  assert.deepEqual(tools, ["list_forms", TEST_TOOL.name]);
});

test("notifications get no reply and blank lines are ignored", async () => {
  const calls: Call[] = [];
  const f = fakeFetch({ "https://app.test/api/v1/mcp": () => new Response(null, { status: 202 }) }, calls);
  assert.equal(await handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), deps(f)), null);
  assert.equal(await handleLine("   ", deps(f)), null);
  assert.equal(calls.length, 1);
});

test("an API auth failure becomes a JSON-RPC error that tells the agent to pair again", async () => {
  const f = fakeFetch(
    { "https://app.test/api/v1/mcp": () => Response.json({ error: { code: "unauthorized", message: "Invalid or revoked API key." } }, { status: 401 }) },
    [],
  );
  const reply = (await handleLine(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_forms" } }), deps(f))) as JsonRpcMessage;
  assert.equal(reply.id, 7);
  const err = reply.error as { message: string };
  assert.match(err.message, /401/);
  assert.match(err.message, /pair <code>/);
});

test("malformed input is answered with a parse error", async () => {
  const reply = (await handleLine("{not json", deps(fakeFetch({}, [])))) as JsonRpcMessage;
  assert.deepEqual(reply.error, { code: -32700, message: "Parse error" });
});

test("send_test_submission posts JSON to the form's endpoint and strips underscore fields", async () => {
  const calls: Call[] = [];
  const f = fakeFetch(
    {
      "https://app.test/api/v1/forms": () => Response.json({ data: [{ id: "f1", name: "Contact", endpoint: "https://forms.test/f/f1" }] }),
      "https://forms.test/f/f1": () => Response.json({ ok: true, id: "sub-1" }),
    },
    calls,
  );
  const reply = (await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: TEST_TOOL.name, arguments: { formId: "f1", values: { email: "a@b.se", message: "hi", _gotcha: "bot", _next: "https://x" } } },
    }),
    deps(f),
  )) as JsonRpcMessage;
  const post = calls.find((c) => c.url === "https://forms.test/f/f1")!;
  const sent = JSON.parse(String(post.init?.body)) as Record<string, unknown>;
  assert.deepEqual(sent, { email: "a@b.se", message: "hi" });
  assert.equal((post.init?.headers as Record<string, string>).accept, "application/json");
  const result = reply.result as { isError: boolean; content: { text: string }[] };
  assert.equal(result.isError, false);
  const summary = JSON.parse(result.content[0].text) as { status: number; sent: string[] };
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.sent, ["email", "message"]);
});

test("send_test_submission refuses an unknown form without touching any endpoint", async () => {
  const calls: Call[] = [];
  const f = fakeFetch({ "https://app.test/api/v1/forms": () => Response.json({ data: [] }) }, calls);
  const reply = (await handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: TEST_TOOL.name, arguments: { formId: "nope" } } }),
    deps(f),
  )) as JsonRpcMessage;
  const result = reply.result as { isError: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No form nope/);
  assert.equal(calls.length, 1);
});
