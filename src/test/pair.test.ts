import { test } from "node:test";
import assert from "node:assert/strict";
import { pair } from "../pair";

type Call = { url: string; init?: RequestInit };

function fakeFetch(routes: Record<string, (init: RequestInit | undefined, n: number) => Response>, calls: Call[]): typeof fetch {
  const counts: Record<string, number> = {};
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const match = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!match) return new Response("not found", { status: 404 });
    counts[match] = (counts[match] ?? 0) + 1;
    return routes[match](init, counts[match]);
  }) as typeof fetch;
}

const CLAIM = { pairingId: "11111111-2222-4333-8444-555555555555", pollToken: "tok", workspace: "Acme", expiresAt: new Date(Date.now() + 60_000).toISOString(), pollEveryMs: 1000 };
const noSleep = async () => {};

test("a permanent status failure stops the poll loop at once", async () => {
  const calls: Call[] = [];
  const f = fakeFetch(
    {
      "https://app.test/api/agent-pairing/claim": () => Response.json(CLAIM, { status: 201 }),
      "https://app.test/api/agent-pairing/status": () => Response.json({ error: "bad_request", message: "pairingId must be the id returned by the claim call." }, { status: 400 }),
    },
    calls,
  );
  const result = await pair({ api: "https://app.test", code: "ABCD-EFGH", agentName: "t", fetchImpl: f, sleep: noSleep });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /pairingId must be/);
  assert.equal(calls.filter((c) => c.url.includes("/status")).length, 1);
});

test("a transient 5xx keeps polling and a later approval still succeeds", async () => {
  const calls: Call[] = [];
  process.env.FORMWARD_CREDENTIALS_FILE = `${process.env.TEMP || process.env.TMPDIR || "/tmp"}/formward-pair-test-${process.pid}.json`;
  const f = fakeFetch(
    {
      "https://app.test/api/agent-pairing/claim": () => Response.json(CLAIM, { status: 201 }),
      "https://app.test/api/agent-pairing/status": (_init, n) =>
        n === 1 ? new Response("bad gateway", { status: 502 }) : Response.json({ status: "approved", apiKey: "fwk_live_test", keyExpiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
    },
    calls,
  );
  const result = await pair({ api: "https://app.test", code: "ABCD-EFGH", agentName: "t", fetchImpl: f, sleep: noSleep });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.workspace, "Acme");
  assert.equal(calls.filter((c) => c.url.includes("/status")).length, 2);
});
