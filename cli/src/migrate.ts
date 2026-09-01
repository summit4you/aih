/**
 * OC#5 residual — `doctor --fix` config self-healing (config schema migration).
 *
 * The OC#5 guard (checkSchemaVersion) makes an OLD build refuse to open a NEWER
 * config (fail-closed). This module is the complementary direction: a NEW build
 * helps a user MIGRATE an older / legacy config UP to the current canonical
 * form — detect the legacy shape, explain what will change, BACK UP the original,
 * then rewrite it stamped and normalized. Idempotent: a second run is a no-op.
 *
 * Pure detection/migration functions (no fs) are exported for smoke testing;
 * the file-level migrate (backup + rewrite) is the side-effecting layer.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG_SCHEMA_VERSION, stampConfigVersion } from "@aih/core";
import type { AihConfig } from "./config.js";

/** One human-readable change a migration would apply to a config file. */
export interface MigrationChange {
  rule: string;
  description: string;
}

/** Result of detecting what migrations a config still needs. */
export interface MigrationReport {
  /** true if at least one migration would change the file. */
  needsMigration: boolean;
  changes: MigrationChange[];
}

/**
 * Detect which schema migrations a config object still needs (pure, no fs).
 *
 * Rule M1 (schemaVersion stamp): a legacy config written before OC#5 has no
 * `schemaVersion`. The guard accepts it (backward compat) but it was never
 * stamped, so a future build cannot tell "legacy, accepted" from "deliberately
 * versioned". Migrate by stamping CONFIG_SCHEMA_VERSION.
 *
 * NOTE: the top-level flat `model` / `baseUrl` are STILL a valid current shape
 * (resolveLlm / loadModelCatalog consume them), so this migration deliberately
 * does NOT touch them — migrating those would break a working config. Only the
 * missing version stamp is a genuine legacy gap.
 */
export function detectConfigMigrations(cfg: AihConfig): MigrationReport {
  const changes: MigrationChange[] = [];
  if (cfg.schemaVersion === undefined) {
    changes.push({
      rule: "M1-schema-version-stamp",
      description: `add schemaVersion=${CONFIG_SCHEMA_VERSION} (legacy config accepted by the guard but never stamped)`,
    });
  }
  return { needsMigration: changes.length > 0, changes };
}

/**
 * Apply the detected migrations to a config object and return the canonical
 * form (pure — does not mutate the input). Idempotent: migrating an already
 * canonical config returns an equal object with no changes.
 */
export function migrateConfig(cfg: AihConfig): { config: AihConfig; changes: MigrationChange[] } {
  const { changes } = detectConfigMigrations(cfg);
  let out: Record<string, unknown> = { ...cfg };
  if (cfg.schemaVersion === undefined) {
    out = stampConfigVersion(out) as Record<string, unknown>;
  }
  return { config: out as AihConfig, changes };
}

/** Result of migrating a config FILE (backup + rewrite). */
export interface MigrateFileResult {
  path: string;
  /** false if the file did not exist or needed no migration. */
  migrated: boolean;
  /** path of the .bak backup, when a backup was written. */
  backup?: string;
  changes: MigrationChange[];
}

/**
 * Migrate a single config file in place: detect → (if needed) back up the
 * original to `<path>.bak.<ts>` → rewrite the canonical form. A missing file or
 * an already-canonical file is a no-op (migrated=false, no backup).
 */
export function migrateConfigFile(path: string): MigrateFileResult {
  if (!existsSync(path)) {
    return { path, migrated: false, changes: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { path, migrated: false, changes: [] };
  }
  let cfg: AihConfig;
  try {
    cfg = JSON.parse(raw) as AihConfig;
  } catch {
    // Unparseable config is not a migration concern (the guard / readConfig
    // will surface it); leave it for the user to fix.
    return { path, migrated: false, changes: [] };
  }
  const { config, changes } = migrateConfig(cfg);
  if (changes.length === 0) {
    return { path, migrated: false, changes: [] };
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.bak.${ts}`;
  copyFileSync(path, backup);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { path, migrated: true, backup, changes };
}

/**
 * The set of config files `doctor --fix` will consider (global user config +
 * the project's aih.json / .aih/config.json, plus the legacy ~/.aih copy).
 * Missing files are fine — migrateConfigFile no-ops on them.
 */
export function configMigrationTargets(userDirs: string[], projectDir: string): string[] {
  const targets: string[] = [];
  for (const d of userDirs) targets.push(`${d}/config.json`);
  targets.push(`${projectDir}/aih.json`);
  targets.push(`${projectDir}/.aih/config.json`);
  return targets;
}
