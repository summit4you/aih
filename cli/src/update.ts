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

// ---- GitHub mirror (offline / GitHub-unreachable) ----------------------------
// Opt-in via AIH_UPDATE_MIRROR, a GitHub download MIRROR prefix (国内镜像),
// e.g. "https://ghfast.top" or "https://ghproxy.com". Both the tarball
// DOWNLOAD and the releases-API CHECK are rewritten to go through it:
//   <mirror>/https://github.com/...
//   <mirror>/https://api.github.com/...
// This is a CDN that can reach GitHub on the user's behalf — no proxy, no
// socks, no extra binary. It is a pure URL rewrite layered over the existing
// native-fetch path, so with AIH_UPDATE_MIRROR unset the behavior is
// byte-identical to before (no regression risk to the normal path).
//
// (User decision: "不用socks代理，是用github.com的国内镜像" — mirror, not proxy.)

/** Normalize a mirror prefix: trim, strip a trailing slash, require an
 *  absolute http(s) URL. Empty string when unset/invalid (→ no mirroring). */
export function mirrorPrefix(): string {
  const raw = (process.env.AIH_UPDATE_MIRROR ?? "").trim();
  if (!raw) return "";
  if (!/^https?:\/\/.+/i.test(raw)) return ""; // not an absolute http(s) URL
  return raw.replace(/\/+$/, "");
}

/** Rewrite an absolute github.com / api.github.com / raw.githubusercontent.com
 *  URL to go through the configured mirror (if any). Non-GitHub URLs and an
 *  unset mirror pass through unchanged. */
export function applyMirror(url: string): string {
  const prefix = mirrorPrefix();
  if (!prefix) return url;
  if (!/^(https?:\/\/)(github\.com|api\.github\.com|raw\.githubusercontent\.com)(\/|$)/i.test(url)) return url;
  return `${prefix}/${url}`;
}

/** Latest release info from the GitHub releases API. */
export interface LatestRelease {
  /** Release tag without the leading "v" (e.g. "0.8.0"). */
  version: string;
  /** When the TARBALL asset was last uploaded (ISO-8601). The release's own
   *  `published_at` does NOT change when assets are re-uploaded (--clobber),
   *  so we read the asset's `updated_at` instead — same-version re-uploads of
   *  the tarball bump THIS timestamp, making the refresh detectable. */
  publishedAt: string;
}

/** Latest release info, or null on failure (network / non-2xx / no tag). */
export async function checkLatestVersion(
  fetchImpl: typeof fetch = fetch,
): Promise<LatestRelease | null> {
  try {
    const res = await fetchImpl(applyMirror(`${API}/latest`), {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { "user-agent": "aih-update-check", accept: "application/json" },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      tag_name?: string;
      published_at?: string;
      assets?: { name?: string; updated_at?: string }[];
    };
    const version = (j.tag_name ?? "").replace(/^v/, "");
    if (!version) return null;
    // Asset-level timestamp: the tarball's last upload wins over the release's
    // published_at (which is stale after a --clobber asset re-upload).
    const tarball = (j.assets ?? []).find((a) => a.name === tarballName(version));
    const publishedAt = tarball?.updated_at || j.published_at || "";
    return { version, publishedAt };
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
  /** The release timestamp we last APPLIED (or silently baselined, see
   *  #baselineAppliedAt). Compare a same-version release's `published_at`
   *  against this to detect a re-uploaded tarball. */
  appliedVersion?: string;
  appliedAt?: string;
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
 * Is this a same-version RE-UPLOAD (tarball refreshed under the same tag)?
 * True only when the version equals the one running AND the remote publish
 * time is newer than what we applied/baselined. Callers use this (plus a
 * strict version compare) to decide "update available" — a fresh tarball
 * with an unchanged version is still a real update.
 */
export function isSameVersionRefresh(
  state: UpdateState,
  latest: LatestRelease,
  currentVersion: string,
): boolean {
  if (compareVersions(latest.version, currentVersion) !== 0) return false;
  const applied = state.appliedAt;
  // No baseline yet: first sighting was already silently baselined by the
  // caller (baselineAppliedAt), which dropped us here only when newer.
  return applied !== undefined && latest.publishedAt > applied;
}

/**
 * Should we nudge about `latest`? Opencode kv semantics: false when the user
 * already skipped this exact version; true for a strictly newer release;
 * true on first sighting (nothing skipped yet). Same-version re-upload
 * filtering is the caller's job via isSameVersionRefresh().
 */
export function shouldPrompt(state: UpdateState, latest: LatestRelease): boolean {
  const skipped = state.skippedVersion;
  if (!skipped) return true;
  if (compareVersions(latest.version, skipped) === 0) return false; // explicitly skipped this exact version
  if (compareVersions(latest.version, skipped) > 0) return true; // strictly newer than skipped → nudge
  return false; // older/equal than a skipped version → silent
}

/**
 * Record a release as applied: after a successful update, or as a silent
 * BASELINE the first time we see a version (so a later same-version re-upload
 * can be detected). Never moves the applied marker backwards.
 */
export function markApplied(version: string, publishedAt: string): void {
  if (!publishedAt) return;
  const s = readState();
  const newer =
    !s.appliedVersion || compareVersions(version, s.appliedVersion) > 0 ||
    (compareVersions(version, s.appliedVersion) === 0 && publishedAt > (s.appliedAt ?? ""));
  if (newer) {
    s.appliedVersion = version;
    s.appliedAt = publishedAt;
    writeState(s);
  }
}

/**
 * Silent BASELINE for a version that has no applied marker yet (first
 * sighting). This is what makes same-version re-upload detection possible:
 * the first time we see vX we remember its published_at; if the same vX is
 * later re-uploaded (newer published_at), shouldPrompt() sees the delta.
 * Never moves the applied marker backwards (a lower/older version does not
 * overwrite a newer applied marker).
 */
export function baselineAppliedAt(version: string, publishedAt: string): void {
  if (!publishedAt) return;
  const s = readState();
  if (!s.appliedVersion) {
    markApplied(version, publishedAt); // first sighting of ANY version
    return;
  }
  const cmp = compareVersions(version, s.appliedVersion);
  if (cmp > 0) {
    markApplied(version, publishedAt); // strictly newer → base it
    return;
  }
  if (cmp === 0 && !s.appliedAt) {
    markApplied(version, publishedAt); // same version, no marker yet → base it
  }
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
  const url = applyMirror(tarballUrl(version)); // 国内镜像 (AIH_UPDATE_MIRROR)
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) {
    throw new Error(
      `download failed: HTTP ${res.status}` +
        (mirrorPrefix()
          ? ` (via mirror ${mirrorPrefix()})`
          : " — if github.com is unreachable from here, set AIH_UPDATE_MIRROR to a GitHub mirror, e.g. AIH_UPDATE_MIRROR=https://ghfast.top"),
    );
  }
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
  latest: LatestRelease | null;
  updateAvailable: boolean;
  skipped: boolean;
  sameVersionRefresh: boolean;
}> {
  const latest = await checkLatestVersion();
  if (!latest) return { current: currentVersion, latest: null, updateAvailable: false, skipped: false, sameVersionRefresh: false };
  baselineAppliedAt(latest.version, latest.publishedAt);
  const cmp = compareVersions(latest.version, currentVersion);
  const updateAvailable = cmp > 0 || isSameVersionRefresh(readState(), latest, currentVersion);
  const skipped = updateAvailable && !shouldPrompt(readState(), latest);
  return {
    current: currentVersion,
    latest,
    updateAvailable,
    skipped,
    sameVersionRefresh: cmp === 0 && updateAvailable,
  };
}
