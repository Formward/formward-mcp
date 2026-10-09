import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// formward.eu serves /api/* directly; app.formward.eu answers /api/* with a 301
// to formward.eu, which would turn every POST into a body-less GET.
export const DEFAULT_API_URL = "https://formward.eu";

/** Where the API lives. Self-hosters and local development override it. */
export function apiUrl(flag?: string): string {
  const raw = flag || process.env.FORMWARD_API_URL || DEFAULT_API_URL;
  return raw.replace(/\/+$/, "");
}

export interface StoredCredential {
  apiKey: string;
  workspace: string;
  expiresAt: string;
  pairedAt: string;
}

type CredentialFile = Record<string, StoredCredential>;

/** One file per user, keyed by API origin, readable by the user only. */
export function credentialsPath(): string {
  if (process.env.FORMWARD_CREDENTIALS_FILE) return process.env.FORMWARD_CREDENTIALS_FILE;
  const base =
    process.env.XDG_CONFIG_HOME ||
    (process.platform === "win32" ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming") : path.join(os.homedir(), ".config"));
  return path.join(base, "formward", "credentials.json");
}

async function readAll(): Promise<CredentialFile> {
  try {
    return (await readStore(credentialsPath())).all;
  } catch {
    return {};
  }
}

/**
 * The store as it is on disk: absent, readable, or present but unreadable.
 * Reads treat the last case as empty; writes must not, or the next save
 * would quietly replace every origin's key with the one just paired.
 */
async function readStore(file: string): Promise<{ all: CredentialFile; corrupt: boolean }> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { all: {}, corrupt: false };
    throw e;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Only well-formed records count: a malformed entry is neither returned
      // (it would become "Bearer undefined") nor carried over on the next write.
      const all: CredentialFile = {};
      for (const [api, cred] of Object.entries(parsed as Record<string, unknown>)) {
        if (isStoredCredential(cred)) all[api] = cred;
      }
      return { all, corrupt: false };
    }
  } catch {
    // fall through
  }
  return { all: {}, corrupt: true };
}

function isStoredCredential(v: unknown): v is StoredCredential {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.apiKey === "string" && c.apiKey.length > 0 &&
    typeof c.workspace === "string" &&
    typeof c.expiresAt === "string" && Number.isFinite(new Date(c.expiresAt).getTime()) &&
    typeof c.pairedAt === "string"
  );
}

/** For writes: an unreadable store is moved aside (never overwritten) and the write starts from empty. */
async function readForWrite(file: string): Promise<CredentialFile> {
  const { all, corrupt } = await readStore(file);
  if (corrupt) {
    const aside = `${file}.corrupt-${Date.now()}`;
    await fs.rename(file, aside);
    process.stderr.write(`formward-mcp: ${file} was not a valid credential store; moved it to ${aside} and started a new one.\n`);
  }
  return all;
}

export async function loadCredential(api: string): Promise<StoredCredential | null> {
  const all = await readAll();
  return all[api] ?? null;
}

/**
 * Replace the store atomically: a crash after writeFile() truncated the old
 * file would leave an empty store, and readAll() would then silently forget
 * every origin's key. The temporary file lives next to the destination (same
 * filesystem, so rename is atomic) and gets the final mode before it holds a
 * key.
 */
async function writeAll(file: string, all: CredentialFile, owned?: () => Promise<void>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    try {
      await fs.chmod(tmp, 0o600);
    } catch {
      // Windows ignores POSIX modes; the file is still inside the user's profile.
    }
    // Last check before the store changes: the lock must still be ours.
    if (owned) await owned();
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/**
 * One read-modify-write at a time across processes: two `pair` runs for
 * different origins would otherwise both read the same snapshot and the
 * last rename would drop the other's key. The lock is a file created with
 * O_EXCL next to the store; a lock older than 10 s is from a crashed process
 * and is taken over.
 */
/** Thrown inside the critical section when the lock no longer carries this process's token; the caller retries from scratch. */
class LockLostError extends Error {}

async function withStoreLock<T>(file: string, fn: (owned: () => Promise<void>) => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  // The lock names its owner (pid plus a token) and, where the filesystem
  // has hard links, is created atomically WITH that content: there is no
  // moment where the lock exists but says nothing. A lock is taken over only
  // when its owner process is gone, never on age alone: a suspended or
  // stalled owner is still an owner. A process removes only a lock that
  // still carries its own token, so a takeover cannot be undone by the old
  // owner's cleanup. Takeover by rename is not atomic with the decision, so
  // the critical section re-checks ownership right before it writes (owned)
  // and starts over if the lock was displaced meanwhile.
  const token = `${process.pid}:${Math.random().toString(36).slice(2)}`;
  const timeoutMs = Number(process.env.FORMWARD_LOCK_TIMEOUT_MS) || 15_000;
  const deadline = Date.now() + timeoutMs;
  let hardLinks = true;
  for (;;) {
    const attempt = await tryCreateLock(lock, token);
    hardLinks = attempt.hardLinks;
    if (attempt.created) break;
    const owner = await fs.readFile(lock, "utf8").catch(() => "");
    const ownerPid = Number(owner.split(":")[0]);
    // An empty lock cannot be produced where hard links work, so one found
    // there is a leftover and counts as abandoned after 2 s. Without hard
    // links an empty lock may be a creator between open() and its token
    // write, and nothing could restore a wrongly taken lock atomically, so it
    // is never taken over: after a crash at that exact point the user deletes
    // the lock the timeout error names.
    const abandoned = owner
      ? ownerPid !== process.pid && !processAlive(ownerPid)
      : hardLinks && (await fs.stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0)) > 2000;
    if (abandoned) {
      // Only one contender wins the rename. What was moved is checked again:
      // the path may have been re-created by someone else since the look. A
      // lock that turns out to belong to a live process is put back; if the
      // path was reacquired in the meantime it is kept aside, never deleted,
      // and its owner's pre-write check (owned) makes that owner start over.
      const taken = `${lock}.${process.pid}.stale`;
      if (await fs.rename(lock, taken).then(() => true, () => false)) {
        const moved = await fs.readFile(taken, "utf8").catch(() => "");
        const movedPid = Number(moved.split(":")[0]);
        if (moved && movedPid !== process.pid && processAlive(movedPid)) {
          const restored = hardLinks
            ? await fs.link(taken, lock).then(() => true, () => false)
            : await fs.access(lock).then(() => false, () => fs.rename(taken, lock).then(() => true, () => false));
          if (!restored) {
            await fs.rename(taken, `${lock}.displaced-${Date.now()}`).catch(() => undefined);
            continue;
          }
        }
        await fs.rm(taken, { force: true });
      }
      continue;
    }
    if (Date.now() > deadline) {
      const who = owner.split(":")[0] || "unknown pid";
      throw new Error(`Credentials file is locked by another formward-mcp process (${who}): ${lock}. If no other formward-mcp is running, delete that file and retry.`);
    }
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
  }
  const owned = async () => {
    if ((await fs.readFile(lock, "utf8").catch(() => "")) !== token) throw new LockLostError(`Lost the credentials lock (${lock}) before writing; retrying.`);
  };
  try {
    return await fn(owned);
  } finally {
    if ((await fs.readFile(lock, "utf8").catch(() => "")) === token) await fs.rm(lock, { force: true });
  }
}

/** Run a locked read-modify-write, starting over (up to 3 times) when the lock was displaced mid-way. */
async function withStoreLockRetrying<T>(file: string, fn: (owned: () => Promise<void>) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withStoreLock(file, fn);
    } catch (e) {
      if (!(e instanceof LockLostError) || attempt >= 3) throw e;
    }
  }
}

/**
 * Create the lock with its token in one step: the token is written to a
 * private file and hard-linked to the lock path, which either succeeds
 * (the lock appears fully formed) or fails with EEXIST. Filesystems without
 * hard links fall back to create-then-write, confirmed by reading the lock
 * back; `hardLinks: false` tells the caller which rules apply.
 */
async function tryCreateLock(lock: string, token: string): Promise<{ created: boolean; hardLinks: boolean }> {
  const tmp = `${lock}.${token.replace(":", ".")}.tmp`;
  await fs.writeFile(tmp, token, { mode: 0o600 });
  try {
    await fs.link(tmp, lock);
    return { created: true, hardLinks: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return { created: false, hardLinks: true };
    const handle = await fs.open(lock, "wx").catch((e2: NodeJS.ErrnoException) => {
      if (e2.code === "EEXIST") return null;
      throw e2;
    });
    if (!handle) return { created: false, hardLinks: false };
    try {
      await handle.writeFile(token);
      await handle.close();
    } catch (e2) {
      // A lock this attempt created but could not finish must not outlive
      // it: empty, it would never be taken over; with a token, it would name
      // a live process that is not holding it.
      await handle.close().catch(() => undefined);
      await fs.rm(lock, { force: true });
      throw e2;
    }
    return { created: (await fs.readFile(lock, "utf8").catch(() => "")) === token, hardLinks: false };
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

export async function saveCredential(api: string, cred: StoredCredential): Promise<string> {
  const file = credentialsPath();
  await withStoreLockRetrying(file, async (owned) => {
    const all = await readForWrite(file);
    all[api] = cred;
    await writeAll(file, all, owned);
  });
  return file;
}

export async function removeCredential(api: string): Promise<boolean> {
  const file = credentialsPath();
  return withStoreLockRetrying(file, async (owned) => {
    const all = await readForWrite(file);
    if (!all[api]) return false;
    delete all[api];
    await writeAll(file, all, owned);
    return true;
  });
}

/**
 * The key to use for this API: an explicit environment variable wins (CI, a
 * classic Professional key), otherwise the paired credential on disk.
 */
export async function resolveApiKey(api: string): Promise<{ apiKey: string; source: "env" | "file"; expiresAt?: string } | null> {
  if (process.env.FORMWARD_API_KEY) return { apiKey: process.env.FORMWARD_API_KEY, source: "env" };
  const stored = await loadCredential(api);
  if (!stored) return null;
  return { apiKey: stored.apiKey, source: "file", expiresAt: stored.expiresAt };
}
