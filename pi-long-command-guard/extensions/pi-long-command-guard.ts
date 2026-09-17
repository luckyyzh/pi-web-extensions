/**
 * Windows workflow guard for foreground Bash / PowerShell.
 * This is a conservative latency heuristic, NOT a shell parser or security boundary.
 * Large timeout = execution budget, not expected duration. Known short read-only
 * commands are exempt; actual waits and common build/install/server jobs are not.
 * Repeating a blocked call never grants permission. MAX_BLOCKS now controls when
 * we request termination of the retry loop, not when the command is allowed.
 * Tool names/arguments are unchanged; no command is automatically executed twice.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPowerShellConfig } from "@earendil-works/pi-coding-agent";

type Shell = "bash" | "powershell";
const DISABLED = process.env.PI_LONG_COMMAND_GUARD_DISABLE === "1";
const DEBUG = process.env.PI_LONG_COMMAND_GUARD_DEBUG === "1";
function setting(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
const TIMEOUT_SECONDS = setting("PI_LONG_COMMAND_GUARD_TIMEOUT_SECONDS", 60);
const SLEEP_SECONDS = setting("PI_LONG_COMMAND_GUARD_SLEEP_SECONDS", 30);
const MAX_BLOCKS = Math.max(1, Math.floor(setting("PI_LONG_COMMAND_GUARD_MAX_BLOCKS", 2)));

/** Mask literal strings/comments before matching executable command positions.
 * Interpolated/eval/nested-script semantics are intentionally not reconstructed.
 */
export function executableText(command: string, shell: Shell): string {
  let source = command.replace(shell === "powershell" ? /`\r?\n/g : /\\\r?\n/g, "");
  if (shell === "powershell") source = source.replace(/@(['"])\r?\n[\s\S]*?\r?\n[ \t]*\1@/g, " ");
  let output = "";
  let quote = "";
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === quote) {
        if (shell === "powershell" && quote === "'" && source[i + 1] === "'") i++;
        else quote = "";
      } else if ((shell === "powershell" && char === "`" && quote === '"')
        || (shell === "bash" && char === "\\" && quote === '"')) i++;
      output += " ";
      continue;
    }
    if (shell === "powershell" && char === "<" && source[i + 1] === "#") {
      const end = source.indexOf("#>", i + 2);
      if (end < 0) break;
      i = end + 1; output += " "; continue;
    }
    if (char === "#" && (i === 0 || /[\s;({]/.test(source[i - 1]))) {
      while (i < source.length && source[i] !== "\n") i++;
      output += "\n"; continue;
    }
    if (char === "'" || char === '"') { quote = char; output += " "; continue; }
    if ((shell === "powershell" && char === "`") || (shell === "bash" && char === "\\")) {
      // An escaped metacharacter is an argument, not a command separator.
      output += " "; i++; continue;
    }
    output += char;
  }
  return output;
}

function sleepInfo(source: string, shell: Shell): { exists: boolean; seconds: number } {
  let seconds = 0;
  let exists = false;
  const pattern = /(?:^|[;&|({\n])[ \t]*(?:(?:do|then)\s+)?(start-sleep|sleep)\s+([^;&|}\n]*)/gi;
  for (const match of source.matchAll(pattern)) {
    if (shell === "bash" && match[1].toLowerCase() !== "sleep") continue;
    exists = true;
    const args = match[2].trim();
    if (shell === "powershell") {
      const named = /^-(seconds|s|sec|milliseconds|m|ms)\s+(\d+(?:\.\d+)?)(?=\s|$)/i.exec(args);
      const positional = /^(\d+(?:\.\d+)?)(?=\s|$)/.exec(args);
      if (named) seconds = Math.max(seconds, Number(named[2]) / (named[1].toLowerCase().startsWith("m") ? 1000 : 1));
      else if (positional) seconds = Math.max(seconds, Number(positional[1]));
    } else {
      let total = 0;
      for (const arg of args.split(/\s+/)) {
        const value = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(arg);
        if (!value) break;
        total += Number(value[1]) * ({s:1,m:60,h:3600,d:86400}[value[2] as "s" | "m" | "h" | "d"] ?? 1);
      }
      seconds = Math.max(seconds, total);
    }
  }
  return { exists, seconds };
}

function segments(source: string): string[] {
  return source.split(/[;&|\n]+/).map(s => s.trim()).filter(Boolean);
}
function knownLong(source: string): boolean {
  return segments(source).some(segment => {
    if (/(?:^|\s)--(?:version|help)(?:\s|$)/i.test(segment)) return false;
    return /^(?:npm|pnpm|yarn)(?:\.cmd|\.exe)?\s+(?:(?:run\s+)?(?:build|test|dev|start)(?:[:\w-]*)(?:\s|$)|(?:install|i|ci)(?:\s|$))/i.test(segment)
      || /^(?:cargo\s+(?:build|test|run)|docker\s+(?:build|compose\s+(?:build|up)))(?:\s|$)/i.test(segment)
      || /^(?:(?:python(?:3)?(?:\.exe)?\s+-m\s+)?pip(?:3)?(?:\.exe)?\s+install)(?:\s|$)/i.test(segment)
      || /^get-content\b.*\s-wait\b/i.test(segment)
      || /^tail\b.*\s-(?:f|F)\b/.test(segment);
  });
}
function knownShort(source: string): boolean {
  const parts = segments(source);
  return parts.length > 0 && parts.every(segment =>
    /^(?:git\s+(?:status|diff|log|ls-files|show|rev-parse)|ls|cat|head|tail|wc|grep|rg|pwd|file|which|where|echo|printf|cd|Get-Content|Get-Item|Get-ChildItem|Get-Command|Test-Path|Get-Location|Get-Date|Write-Output|Select-Object|Select-String|Measure-Object|Set-Location)(?:\s|$)/i.test(segment)
    || /^(?:npm|pnpm|yarn|node|python|cargo|docker)(?:\.cmd|\.exe)?\s+--(?:version|help)\s*$/i.test(segment));
}

export function classifyCommand(command: string, shell: Shell, timeout?: number): "watch" | "spawn" | undefined {
  const source = executableText(command, shell);
  const sleep = sleepInfo(source, shell);
  const loop = sleep.exists && (/\b(?:while|until|for|foreach)\b/i.test(source) || /\$\(\s*seq\b|\{\d+\.\.\d+\}/.test(source));
  if (loop || sleep.seconds >= SLEEP_SECONDS) return "watch";
  if (knownLong(source)) return "spawn";
  if (timeout !== undefined && timeout >= TIMEOUT_SECONDS && !knownShort(source)) return "spawn";
  return undefined;
}

function example(shell: Shell, command: string, kind: "watch" | "spawn", cwd?: string, timeout?: number): object {
  const text = kind === "watch" ? "<只执行一次的探测命令，去掉 sleep 和循环>" : command;
  let execution: { command?: string; shell?: boolean; argv?: string[] };
  if (shell === "powershell") {
    // Same exported resolver and argv as Pi's foreground PowerShell tool.
    // Do not guess pwsh is installed or silently switch PowerShell versions.
    const config = getPowerShellConfig();
    execution = { shell: false, argv: [config.shell, ...config.args, text] };
  } else execution = { command: text };
  return { ...execution, ...(cwd ? { cwd } : {}),
    ...(kind === "watch"
      ? { success_when: { type: "exit_code", equals: 0 }, interval_seconds: 30, timeout_seconds: 900 }
      : (timeout && Number.isFinite(timeout) ? { timeout_seconds: timeout } : {})),
  };
}

export default function (pi: ExtensionAPI): void {
  if (DISABLED || process.platform !== "win32") return;
  const attempts = new Map<string, number>();
  pi.on("session_start", () => attempts.clear());
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") return;
    const input = event.input as { command?: unknown; timeout?: unknown };
    if (typeof input.command !== "string" || !input.command.trim()) return;
    const shell = event.toolName;
    const timeout = typeof input.timeout === "number" ? input.timeout : undefined;
    const kind = classifyCommand(input.command, shell, timeout);
    if (!kind) return;
    const key = `${shell}:${kind}:${input.command.trim()}`;
    const count = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, count);
    if (DEBUG) process.stderr.write(`[pi-long-command-guard] blocked ${shell}/${kind}, attempt=${count}\n`);
    if (count > MAX_BLOCKS) return { block: true, terminate: true,
      reason: "同一长命令已多次被拦截，未执行，且不会因重复而放行。停止重试：按先前建议改后台，或向用户确认前台执行策略。" };
    const active = pi.getActiveTools();
    const tool = active.includes(`bg_task_${kind}`) ? `bg_task_${kind}` : active.includes("bg_task") ? "bg_task" : undefined;
    if (!tool) return { block: true, terminate: true,
      reason: "命令未执行：检测到长任务/等待，但当前没有可用的后台执行工具。不要删 timeout 或重复重试；请用户启用后台插件，或确认其他执行方式。" };
    let args: object;
    try { args = example(shell, input.command, kind, ctx.cwd, timeout); }
    catch { return { block: true, terminate: true,
      reason: "命令未执行：无法解析前台 PowerShell 的实际可执行文件。请先核实 PowerShell 安装/配置，不能把该代码交给默认 Bash。" }; }
    if (tool === "bg_task") args = { action: kind, ...args };
    return { block: true, reason: [
      `命令未执行：${kind === "watch" ? "检测到等待/轮询，应改为单次后台探测。" : "检测到常见长任务，或未知命令申请了较大的前台执行预算。timeout 是上限，不代表预计耗时。"}`,
      `${tool}(${JSON.stringify(args)})`,
      kind === "watch" ? "探测必须只读；按实际输出设置 success_when/failure_when，不能机械使用 exit_code=0。默认保留有限超时。" : "保持原 shell、cwd、必要 env；这是改道建议，未替你启动任务。",
      "不要删 timeout 绕过；启动后记录 task id，只做独立工作，无独立工作则等待通知，不忙轮询。",
      "通知后先 bg_task_status，摘要不足再 bg_task_log（有限 tail_lines）；验证产物后才完成父计划。",
    ].join("\n") };
  });
}
