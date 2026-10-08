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
    const parsed: unknown = JSON.parse(await fs.readFile(credentialsPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as CredentialFile) : {};
  } catch {
    return {};
  }
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

export async function saveCredential(api: string, cred: StoredCredential): Promise<string> {
  const file = credentialsPath();
  const all = await readAll();
  all[api] = cred;
  await writeAll(file, all);
  return file;
}

export async function removeCredential(api: string): Promise<boolean> {
  const all = await readAll();
  if (!all[api]) return false;
  delete all[api];
  await writeAll(credentialsPath(), all);
  return true;
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
