// Shell environment policy (borrowed from Codex CLI's shell_environment_policy,
// Apache-2.0): spawned commands get a filtered environment so secrets
// (API keys, tokens, passwords) are not exposed to agent-executed processes.

const SECRET_HINT = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)/i;

export interface EnvPolicyOptions {
  /** Extra vars to force-set in the child env after filtering (Codex `set`). */
  set?: Record<string, string>;
}

/**
 * Build the child process env:
 *  1. drop variables whose NAME looks secret-bearing (default excludes);
 *  2. drop AIH provider credentials explicitly (AIH_API_KEY etc.);
 *  3. apply forced `set` entries last.
 * PATH/HOME/TERM/SHELL and other benign vars pass through untouched.
 */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv = process.env,
  opts: EnvPolicyOptions = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    // Default excludes: name contains a secret hint (KEY, TOKEN, SECRET...).
    if (SECRET_HINT.test(name)) continue;
    env[name] = value;
  }
  // The CLI's own provider credential never reaches child processes even if
  // renamed without a hint word.
  for (const name of Object.keys(env)) {
    if (name.startsWith("AIH_") && /API/i.test(name)) delete env[name];
  }
  if (opts.set) Object.assign(env, opts.set);
  return env;
}
