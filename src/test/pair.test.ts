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

test("a 200 whose body is not a status object is transient, not a crash", async () => {
  const calls: Call[] = [];
  process.env.FORMWARD_CREDENTIALS_FILE = `${process.env.TEMP || process.env.TMPDIR || "/tmp"}/formward-pair-test-null-${process.pid}.json`;
  const f = fakeFetch(
    {
      "https://app.test/api/agent-pairing/claim": () => Response.json(CLAIM, { status: 201 }),
      "https://app.test/api/agent-pairing/status": (_init, n) =>
        n === 1 ? Response.json(null) : n === 2 ? Response.json("approved") : Response.json({ status: "approved", apiKey: "fwk_live_test" }),
    },
    calls,
  );
  const result = await pair({ api: "https://app.test", code: "ABCD-EFGH", agentName: "t", fetchImpl: f, sleep: noSleep });
  assert.equal(result.ok, true);
  assert.equal(calls.filter((c) => c.url.includes("/status")).length, 3);
});

test("the credential store is replaced whole, keeps other origins and leaves no temporary file", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { loadCredential, removeCredential, saveCredential } = await import("../config");
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "formward-store-"));
  const file = path.join(dir, "credentials.json");
  process.env.FORMWARD_CREDENTIALS_FILE = file;
  const cred = (apiKey: string) => ({ apiKey, workspace: "Acme", expiresAt: "2030-01-01T00:00:00.000Z", pairedAt: "2026-01-01T00:00:00.000Z" });
  await saveCredential("https://a.test", cred("fwk_a"));
  await saveCredential("https://b.test", cred("fwk_b"));
  assert.equal((await loadCredential("https://a.test"))?.apiKey, "fwk_a");
  assert.equal((await loadCredential("https://b.test"))?.apiKey, "fwk_b");
  assert.equal(await removeCredential("https://a.test"), true);
  assert.equal(await loadCredential("https://a.test"), null);
  assert.equal((await loadCredential("https://b.test"))?.apiKey, "fwk_b");
  assert.deepEqual(fs.readdirSync(dir), ["credentials.json"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("concurrent saves for different origins both survive", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { loadCredential, saveCredential } = await import("../config");
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "formward-store-race-"));
  process.env.FORMWARD_CREDENTIALS_FILE = path.join(dir, "credentials.json");
  const cred = (apiKey: string) => ({ apiKey, workspace: "Acme", expiresAt: "2030-01-01T00:00:00.000Z", pairedAt: "2026-01-01T00:00:00.000Z" });
  await Promise.all(["a", "b", "c", "d"].map((n) => saveCredential(`https://${n}.test`, cred(`fwk_${n}`))));
  for (const n of ["a", "b", "c", "d"]) assert.equal((await loadCredential(`https://${n}.test`))?.apiKey, `fwk_${n}`);
  assert.deepEqual(fs.readdirSync(dir), ["credentials.json"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a lock left by a dead process is taken over, and concurrent takers still serialize", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { loadCredential, saveCredential } = await import("../config");
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "formward-store-stale-"));
  const file = path.join(dir, "credentials.json");
  process.env.FORMWARD_CREDENTIALS_FILE = file;
  // A pid no live process has (near the platform maximum), written seconds ago: age is irrelevant, liveness decides.
  fs.writeFileSync(`${file}.lock`, "2147483646:deadbeef");
  const cred = (apiKey: string) => ({ apiKey, workspace: "Acme", expiresAt: "2030-01-01T00:00:00.000Z", pairedAt: "2026-01-01T00:00:00.000Z" });
  await Promise.all(["a", "b", "c"].map((n) => saveCredential(`https://${n}.test`, cred(`fwk_${n}`))));
  for (const n of ["a", "b", "c"]) assert.equal((await loadCredential(`https://${n}.test`))?.apiKey, `fwk_${n}`);
  assert.deepEqual(fs.readdirSync(dir), ["credentials.json"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a lock held by a live process is never taken over, and its file is left alone", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { saveCredential } = await import("../config");
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "formward-store-live-"));
  const file = path.join(dir, "credentials.json");
  process.env.FORMWARD_CREDENTIALS_FILE = file;
  process.env.FORMWARD_LOCK_TIMEOUT_MS = "300";
  // Held by this very process under another token: alive, so it must be respected until the timeout.
  const foreign = `${process.pid}:someone-else`;
  fs.writeFileSync(`${file}.lock`, foreign);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${file}.lock`, old, old);
  await assert.rejects(
    saveCredential("https://a.test", { apiKey: "fwk_a", workspace: "Acme", expiresAt: "2030-01-01T00:00:00.000Z", pairedAt: "2026-01-01T00:00:00.000Z" }),
    /locked by another formward-mcp process/,
  );
  assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), foreign);
  assert.equal(fs.existsSync(file), false);
  delete process.env.FORMWARD_LOCK_TIMEOUT_MS;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unreadable credential store is moved aside, never overwritten", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { loadCredential, saveCredential } = await import("../config");
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "formward-store-corrupt-"));
  const file = path.join(dir, "credentials.json");
  process.env.FORMWARD_CREDENTIALS_FILE = file;
  fs.writeFileSync(file, "{ not json");
  assert.equal(await loadCredential("https://a.test"), null);
  await saveCredential("https://a.test", { apiKey: "fwk_a", workspace: "Acme", expiresAt: "2030-01-01T00:00:00.000Z", pairedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal((await loadCredential("https://a.test"))?.apiKey, "fwk_a");
  const names = fs.readdirSync(dir).sort();
  assert.equal(names.length, 2);
  assert.equal(names[0], "credentials.json");
  assert.match(names[1], /^credentials\.json\.corrupt-\d+$/);
  assert.equal(fs.readFileSync(path.join(dir, names[1]), "utf8"), "{ not json");
  fs.rmSync(dir, { recursive: true, force: true });
});
