/**
 * Shell tool prompt generation — produces a rich, shell-aware description
 * for the `run_cmd` tool, similar to opencode's shell.txt / ShellPrompt.
 *
 * Adapts guidance to the detected shell (bash/zsh/sh) and OS, and includes
 * best practices for command execution, output handling, and safety.
 */

import { platform, homedir } from "node:os";

export interface ShellPromptOptions {
  cwd: string;
  timeoutMs: number;
  maxLines: number;
  maxBytes: number;
  shellName: string; // "bash" | "zsh" | "sh" | "powershell" | "pwsh" | "cmd"
}

function osName(): string {
  switch (platform()) {
    case "darwin": return "macOS";
    case "win32": return "Windows";
    case "linux": return "Linux";
    default: return platform();
  }
}

function shellNotes(name: string): string {
  if (name === "powershell" || name === "pwsh") {
    return `- PowerShell uses pipeline chain operators (\`&&\` and \`||\`).
- Use double quotes for interpolated strings (\`"Hello $name"\`), single quotes for verbatim strings.
- Prefer full cmdlet names like \`Get-ChildItem\`, \`Set-Content\`, \`Remove-Item\`.
- Use \`$(...)\` for subexpressions. Use \`& "path/to/exe"\` for native executables with spaces.`;
  }
  return `- Chain dependent commands with \`&&\` (e.g., \`git add . && git commit -m "msg"\`).
- Use \`;\` only when you don't care if earlier commands fail.
- Use the \`workdir\` parameter instead of \`cd\` when possible.`;
}

/**
 * Generate the full tool description for the shell/run_cmd tool.
 */
export function generateShellDescription(opts: ShellPromptOptions): string {
  const notes = shellNotes(opts.shellName);

  return [
    `Run a shell command in the workspace (OS: ${osName()}, Shell: ${opts.shellName}).`,
    ``,
    `Before executing, verify the parent directory exists (use \`ls\`) if the command will create files/dirs.`,
    ``,
    `**Parameters:**`,
    `- \`command\` (required): the command to run via ${opts.shellName} -c`,
    `- \`workdir\` (optional): working directory — prefer this over \`cd\``,
    `- \`timeout_ms\` (optional): timeout in ms (default ${opts.timeoutMs}, max 600000)`,
    `- \`keep_output\` (optional): persist full output to file for inspection beyond the cap`,
    `- \`sandbox\` (optional): execution backend — local (default) | bwrap | remote`,
    ``,
    `**Output:** Returns merged stdout+stderr. If output exceeds ${opts.maxLines} lines or ${opts.maxBytes} bytes,`,
    `it is middle-truncated (head+tail kept, verdict lines preserved). Use \`keep_output=true\` for full output.`,
    ``,
    `**Usage guidelines:**`,
    `- Do NOT use bash for file operations when dedicated tools exist (use edit/grep/glob/read/write instead).`,
    `- Prefer specialized tools: Glob for file search, Grep for content search, Read for file reading.`,
    `- For independent commands, make parallel tool calls in a single message.`,
    `${notes}`,
    `- Quote paths containing spaces with double quotes.`,
    `- Avoid \`cd <dir> && <cmd>\` — use the \`workdir\` parameter instead.`,
    ``,
    `**Safety:**`,
    `- Write commands (rm, mv, cp, mkdir, chmod, etc.) require user approval.`,
    `- Commands touching files outside the workspace require explicit permission.`,
    `- Environment variables are filtered to prevent secret leakage.`,
  ].join("\n");
}
