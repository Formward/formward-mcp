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

/** The remote MCP endpoint answering list_forms with the given forms (how the real server responds). */
function listFormsRoute(forms: { id: string; name: string; endpoint: string }[]) {
  return (init?: RequestInit) => {
    const msg = JSON.parse(String(init?.body)) as JsonRpcMessage;
    assert.equal(msg.method, "tools/call");
    assert.equal((msg.params as { name: string }).name, "list_forms");
    return Response.json({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ data: forms }) }], isError: false } });
  };
}

test("send_test_submission resolves the endpoint via list_forms, posts JSON and keeps consent but not honeypot/redirect", async () => {
  const calls: Call[] = [];
  const f = fakeFetch(
    {
      "https://app.test/api/v1/mcp": listFormsRoute([{ id: "f1", name: "Contact", endpoint: "https://forms.test/f/f1" }]),
      "https://forms.test/f/f1": () => Response.json({ ok: true, id: "sub-1" }),
    },
    calls,
  );
  const reply = (await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: TEST_TOOL.name,
        arguments: { formId: "f1", values: { email: "a@b.se", message: "hi", _consent: "on", _subject: "Test", _gotcha: "bot", _next: "https://x", _redirect: "https://y" } },
      },
    }),
    deps(f),
  )) as JsonRpcMessage;
  // Only the MCP endpoint was used for the lookup, never the plan-gated REST list.
  assert.ok(calls.every((c) => !c.url.includes("/api/v1/forms")));
  const post = calls.find((c) => c.url === "https://forms.test/f/f1")!;
  const sent = JSON.parse(String(post.init?.body)) as Record<string, unknown>;
  assert.deepEqual(sent, { email: "a@b.se", message: "hi", _consent: "on", _subject: "Test" });
  assert.equal((post.init?.headers as Record<string, string>).accept, "application/json");
  const result = reply.result as { isError: boolean; content: { text: string }[] };
  assert.equal(result.isError, false);
  const summary = JSON.parse(result.content[0].text) as { status: number; sent: string[] };
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.sent, ["email", "message", "_consent", "_subject"]);
});

test("send_test_submission surfaces a failed lookup as a tool error", async () => {
  const f = fakeFetch({ "https://app.test/api/v1/mcp": () => { throw new TypeError("fetch failed"); } }, []);
  const reply = (await handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: TEST_TOOL.name, arguments: { formId: "f1" } } }),
    deps(f),
  )) as JsonRpcMessage;
  const result = reply.result as { isError: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Could not (list forms|reach)/);
});

test("a JSON-RPC batch gets local tools too and is answered as a batch", async () => {
  const calls: Call[] = [];
  const f = fakeFetch(
    {
      "https://app.test/api/v1/mcp": (init) => {
        const msg = JSON.parse(String(init?.body)) as JsonRpcMessage;
        assert.ok(!Array.isArray(msg), "elements are forwarded one by one");
        if (msg.method === "tools/list") {
          return Response.json({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "list_forms", description: "", inputSchema: {} }] } });
        }
        return listFormsRoute([{ id: "f1", name: "Contact", endpoint: "https://forms.test/f/f1" }])(init);
      },
      "https://forms.test/f/f1": () => Response.json({ ok: true, id: "sub-2" }),
    },
    calls,
  );
  const reply = (await handleLine(
    JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: TEST_TOOL.name, arguments: { formId: "f1" } } },
    ]),
    deps(f),
  )) as JsonRpcMessage[];
  assert.ok(Array.isArray(reply));
  assert.deepEqual(reply.map((r) => r.id), [1, 2]);
  const tools = (reply[0].result as { tools: { name: string }[] }).tools.map((t) => t.name);
  assert.deepEqual(tools, ["list_forms", TEST_TOOL.name]);
  const sent = (reply[1].result as { isError: boolean; content: { text: string }[] });
  assert.equal(sent.isError, false);
  assert.ok(calls.some((c) => c.url === "https://forms.test/f/f1"));
});

test("a response body that fails to read becomes a per-request error, not a hung request", async () => {
  const broken = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("socket hang up"));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const f = fakeFetch({ "https://app.test/api/v1/mcp": broken }, []);
  const reply = (await handleLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }), deps(f))) as JsonRpcMessage;
  assert.equal(reply.id, 9);
  assert.match((reply.error as { message: string }).message, /socket hang up/);
});

test("send_test_submission refuses an unknown form without touching any endpoint", async () => {
  const calls: Call[] = [];
  const f = fakeFetch({ "https://app.test/api/v1/mcp": listFormsRoute([]) }, calls);
  const reply = (await handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: TEST_TOOL.name, arguments: { formId: "nope" } } }),
    deps(f),
  )) as JsonRpcMessage;
  const result = reply.result as { isError: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No form nope/);
  assert.equal(calls.length, 1);
});
