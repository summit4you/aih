/**
 * Self-update (opencode `installation/upgrade` parity, adapted to AIH's
 * tarball install layout).
 *
 * Flow (mirrors opencode's cli/upgrade.ts + TUI update-available dialog):
 *   1. checkLatest()  — GitHub `releases/latest`, bounded timeout, silent on failure
 *   2. compareVersions — semver-ish numeric compare; 0 = equal
 *   3. updateState    — skip memory: a skipped version is not nagged again,
 *                       but a NEWER release re-triggers the prompt (opencode kv "skipped_version")
 *   4. detectInstallDir — only the tarball layout (~/.local/share/aih/app) is
 *                       auto-updatable; dev checkouts / npm installs report
 *                       the install command instead (opencode method="unknown")
 *   5. downloadTarball — to a staging dir FIRST (user asked: download locally before applying)
 *   6. applyUpdate    — extract, verify, backup, atomic swap; never deletes the
 *                       old install before the new one is proven good
 *
 * Kill switch: AIH_DISABLE_UPDATE_CHECK=1 (skip check + /update refuses).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GITHUB_REPO = "summit4you/aih";
const API = `https://api.github.com/repos/${GITHUB_REPO}/releases`;
const DL = `https://github.com/${GITHUB_REPO}/releases/download`;
const CHECK_TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 120000;

/** Latest release tag without the leading "v" (e.g. "0.8.0"), or null on failure. */
export async function checkLatestVersion(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`${API}/latest`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { "user-agent": "aih-update-check", accept: "application/json" },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { tag_name?: string };
    return (j.tag_name ?? "").replace(/^v/, "") || null;
  } catch {
    return null;
  }
}

/** Numeric semver compare: >0 if a>b, <0 if a<b, 0 if equal. Non-numeric parts ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Tarball name convention (scripts/package): aih-<version>-node.tar.gz */
export function tarballName(version: string): string {
  return `aih-${version.replace(/^v/, "")}-node.tar.gz`;
}

export function tarballUrl(version: string): string {
  return `${DL}/v${version.replace(/^v/, "")}/${tarballName(version)}`;
}

// ---- skip state (opencode kv "skipped_version") -------------------------------

export interface UpdateState {
  skippedVersion?: string;
  lastCheckAt?: string;
}

export function statePath(): string {
  // AIH_UPDATE_STATE_PATH override for tests (same pattern as AIH_ENV_PATH)
  if (process.env.AIH_UPDATE_STATE_PATH) return process.env.AIH_UPDATE_STATE_PATH;
  return path.join(os.homedir(), ".local", "share", "aih", "update-state.json");
}

export function readState(): UpdateState {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8")) as UpdateState;
  } catch {
    return {};
  }
}

export function writeState(s: UpdateState): void {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(s, null, 2));
  } catch {
    /* state is advisory — never fail an update over it */
  }
}

/**
 * Should we still nudge about `latest`? False when the user already skipped
 * this exact version OR a newer one; true for a strictly newer release.
 */
export function shouldPrompt(state: UpdateState, latest: string): boolean {
  const skipped = state.skippedVersion;
  if (!skipped) return true;
  return compareVersions(latest, skipped) > 0;
}

export function markSkipped(version: string): void {
  const s = readState();
  if (!s.skippedVersion || compareVersions(version, s.skippedVersion) > 0) {
    s.skippedVersion = version;
    writeState(s);
  }
}

// ---- install-dir detection ----------------------------------------------------

/**
 * The tarball layout puts the app at <dir>/app with a launcher <dir>/app/aih.
 * A process running FROM that layout can be updated in place. Anything else
 * (repo checkout, npm -g, npx) returns null → caller shows the install command.
 */
/**
 * The entry script (process.argv[1]) is the reliable signal — the launcher is
 * a SHELL script, so process.execPath is just the node binary.
 */
function entryScript(): string {
  return process.argv[1] ?? "";
}

export function detectInstallDir(execPath: string = entryScript()): string | null {
  // tarball layout: <installDir>/app/aih (launcher) — the app dir must be named "app"
  if (!execPath) return null;
  const appDir = path.dirname(execPath);
  if (path.basename(appDir) !== "app") return null;
  const installDir = path.resolve(path.dirname(appDir));
  // The entry script must actually live INSIDE this install dir — otherwise
  // we'd be running a dev checkout and "updating" would clobber the real
  // installed app in ~/.local/share/aih.
  if (!path.resolve(execPath).startsWith(installDir + path.sep)) return null;
  if (fs.existsSync(path.join(installDir, "app", "aih"))) return installDir;
  return null;
}

// ---- download + apply ----------------------------------------------------------

export interface DownloadResult {
  tarball: string; // staged tarball path
  bytes: number;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 1, stderr: stderr || "spawn failed" });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr });
    });
  });
}

export async function downloadTarball(version: string, destDir: string): Promise<DownloadResult> {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, tarballName(version));
  const url = tarballUrl(version);
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return { tarball: dest, bytes: buf.length };
}

export interface ApplyResult {
  installDir: string;
  backup: string | null;
}

/**
 * Extract the staged tarball into a sibling dir, verify the launcher exists,
 * then swap: old → .bak, new → app. The old install is NEVER removed before
 * the new one is verified; on any failure the previous layout is restored.
 */
export async function applyUpdate(
  tarball: string,
  version: string,
  entry: string = entryScript(),
): Promise<ApplyResult> {
  const installDir = detectInstallDir(entry);
  if (!installDir) {
    throw new Error(
      "not a tarball install (expected <dir>/app/aih) — install with: " +
        `curl -fsSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/scripts/install | bash`,
    );
  }
  const appDir = path.join(installDir, "app");
  const stage = path.join(installDir, `.app-new-${Date.now()}`);
  const backup = path.join(installDir, `.app-bak-${Date.now()}`);

  fs.mkdirSync(stage, { recursive: true });
  const extract = await run("tar", ["-xzf", tarball, "-C", stage], DOWNLOAD_TIMEOUT_MS);
  if (extract.code !== 0) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw new Error(`extract failed: ${extract.stderr.slice(0, 200)}`);
  }
  if (!fs.existsSync(path.join(stage, "aih"))) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw new Error("extracted tarball is missing the aih launcher — aborted, nothing changed");
  }
  // sanity: new launcher reports a version (tarball launcher is a node ESM script)
  const ver = await run(process.execPath, [path.join(stage, "aih"), "--version"], 15000);
  if (ver.code !== 0) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw new Error(`new aih --version failed: ${ver.stderr.slice(0, 200)}`);
  }

  // swap (rename is atomic on the same filesystem)
  fs.renameSync(appDir, backup);
  try {
    fs.renameSync(stage, appDir);
  } catch (e) {
    fs.renameSync(backup, appDir); // restore
    fs.rmSync(stage, { recursive: true, force: true });
    throw e instanceof Error ? e : new Error("swap failed");
  }
  fs.rmSync(backup, { recursive: true, force: true });
  return { installDir, backup: null };
}

/** One-shot check for CLI `aih update --check`. */
export async function checkUpdate(currentVersion: string): Promise<{
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  skipped: boolean;
}> {
  const latest = await checkLatestVersion();
  if (!latest) return { current: currentVersion, latest: null, updateAvailable: false, skipped: false };
  const updateAvailable = compareVersions(latest, currentVersion) > 0;
  const skipped = updateAvailable && !shouldPrompt(readState(), latest);
  return { current: currentVersion, latest, updateAvailable, skipped };
}
