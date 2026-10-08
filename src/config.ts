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
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { all: parsed as CredentialFile, corrupt: false };
  } catch {
    // fall through
  }
  return { all: {}, corrupt: true };
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
async function writeAll(file: string, all: CredentialFile): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    try {
      await fs.chmod(tmp, 0o600);
    } catch {
      // Windows ignores POSIX modes; the file is still inside the user's profile.
    }
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
async function withStoreLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  // The lock names its owner (pid plus a token) and is created atomically
  // WITH that content (see tryCreateLock), so there is no moment where the
  // lock exists but says nothing. A lock is taken over only when its owner
  // process is gone, never on age alone: a suspended or stalled owner is
  // still an owner. A process removes only a lock that still carries its
  // own token, so a takeover can never be undone by the old owner's cleanup.
  const token = `${process.pid}:${Math.random().toString(36).slice(2)}`;
  const timeoutMs = Number(process.env.FORMWARD_LOCK_TIMEOUT_MS) || 15_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tryCreateLock(lock, token)) break;
    const owner = await fs.readFile(lock, "utf8").catch(() => "");
    const ownerPid = Number(owner.split(":")[0]);
    // An empty lock can only come from the no-hard-link fallback in
    // tryCreateLock (its creator died, or is still about to write); it counts
    // as abandoned once it has stayed empty for 2 s.
    const abandoned = owner
      ? ownerPid !== process.pid && !processAlive(ownerPid)
      : (await fs.stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0)) > 2000;
    if (abandoned) {
      // Only one contender wins the rename. What was moved is then checked
      // again: between the look and the rename the lock may have been
      // re-created by someone else, or an empty one may have received its
      // creator's token. A lock that turns out to be live is put back.
      const taken = `${lock}.${process.pid}.stale`;
      if (await fs.rename(lock, taken).then(() => true, () => false)) {
        const moved = await fs.readFile(taken, "utf8").catch(() => "");
        const movedPid = Number(moved.split(":")[0]);
        if (moved && movedPid !== process.pid && processAlive(movedPid)) {
          await fs.link(taken, lock).catch(() => undefined);
        }
        await fs.rm(taken, { force: true });
      }
      continue;
    }
    if (Date.now() > deadline) throw new Error(`Credentials file is locked by another formward-mcp process (${owner.split(":")[0] || "unknown pid"}): ${lock}`);
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
  }
  try {
    return await fn();
  } finally {
    if ((await fs.readFile(lock, "utf8").catch(() => "")) === token) await fs.rm(lock, { force: true });
  }
}

/**
 * Create the lock with its token in one step: the token is written to a
 * private file and hard-linked to the lock path, which either succeeds
 * (the lock appears fully formed) or fails with EEXIST. Filesystems without
 * hard links fall back to create-then-write, confirmed by reading the lock
 * back: if it does not carry this token, it was taken over while we stalled.
 */
async function tryCreateLock(lock: string, token: string): Promise<boolean> {
  const tmp = `${lock}.${token.replace(":", ".")}.tmp`;
  await fs.writeFile(tmp, token, { mode: 0o600 });
  try {
    await fs.link(tmp, lock);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    try {
      const handle = await fs.open(lock, "wx");
      await handle.writeFile(token);
      await handle.close();
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e2;
    }
    return (await fs.readFile(lock, "utf8").catch(() => "")) === token;
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
  await withStoreLock(file, async () => {
    const all = await readForWrite(file);
    all[api] = cred;
    await writeAll(file, all);
  });
  return file;
}

export async function removeCredential(api: string): Promise<boolean> {
  const file = credentialsPath();
  return withStoreLock(file, async () => {
    const all = await readForWrite(file);
    if (!all[api]) return false;
    delete all[api];
    await writeAll(file, all);
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
