/**
 * stop-cancels-background-tasks.ts —— 用户 stop = 取消本会话的活跃后台任务（仅 Windows）
 *
 * 行为：
 *   - agent_end 时唯一判据是 ctx.signal?.aborted === true（当前轮真的被 abort）。
 *     不看 stopReason / 错误字符串 —— 那些形态随 pi 版本会变，猜取消会造成误杀。
 *   - 命中后按本会话 origin（cwd + sessionId，由 bg-tasks registry 过滤）顺序
 *     stopTask 所有活跃任务。stopTask 会杀进程树、置 cancelled、抑制完成回调，
 *     所以被取消的任务不会再唤醒 agent。
 *   - 正常完成不杀；session_shutdown（关 pi-web / 会话销毁 / 空闲回收）之后的
 *     abort 不杀 —— 那一次 abort 是销毁流程触发的，不是用户按 stop。
 *   - 拿不到 sessionId 时保守地一个都不取消：同目录无 sessionId 的任务可能属于
 *     别的会话，宁可漏杀不可误杀（会向用户告警一次）。
 *   - /bg-stop-all：空闲时的显式停止入口（不是自动命令），通过 ctx.ui 报告
 *     成功/失败数。stopTask 返回的真实 status 不再是 running 才算成功。
 *
 * 降级（对用户可见，不只是 debug）：
 *   - 私有模块拿不到：session_start 和 /bg-stop-all 都明确警告，stop 退回原行为。
 *   - 个别任务停不掉（仍 running / 抛异常）：计为失败并警告。
 *
 * 范围：仅 Windows 激活；非 Windows 上本模块整体不启用。
 * 环境变量：PI_STOP_CANCELS_TASKS=0 关闭；PI_STOP_CANCELS_TASKS_DEBUG=1 或哨兵文件
 *   <tmp>/pi-stop-cancels.debug 打开日志（追加到 <tmp>/pi-stop-cancels.log）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ENABLED = process.env.PI_STOP_CANCELS_TASKS !== "0";
const IS_WINDOWS = process.platform === "win32";
const DEBUG_ENV = process.env.PI_STOP_CANCELS_TASKS_DEBUG === "1";
const DEBUG_FLAG_FILE = join(tmpdir(), "pi-stop-cancels.debug");
const DEBUG_LOG_FILE = join(tmpdir(), "pi-stop-cancels.log");

type TaskOrigin = { cwd: string; sessionId?: string };
type TaskMeta = { id: string; name?: string; status?: string; error?: string };

interface BackgroundTasksInternals {
  stopTask(pi: ExtensionAPI, id: string, getActiveSession?: () => TaskOrigin | undefined): Promise<TaskMeta | undefined>;
  listActiveMetasForOrigin(origin: TaskOrigin): TaskMeta[];
}

function debug(message: string): void {
  if (!DEBUG_ENV && !existsSync(DEBUG_FLAG_FILE)) return;
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    appendFileSync(DEBUG_LOG_FILE, line);
  } catch {
    // 日志只是排查手段，写不进去就算了。
  }
  if (DEBUG_ENV) process.stderr.write(`[stop-cancels-background-tasks] ${message}\n`);
}

/**
 * bg-tasks 私有模块（有意破例复用；包升级改结构会失败，失败走上面的用户可见降级）。
 */
async function loadInternals(): Promise<BackgroundTasksInternals | undefined> {
  const sourceDir = join(getAgentDir(), "npm", "node_modules", "pi-better-background-tasks", "src");
  try {
    const runtime = (await import(pathToFileURL(join(sourceDir, "runtime.ts")).href)) as Partial<BackgroundTasksInternals>;
    const registry = (await import(pathToFileURL(join(sourceDir, "registry.ts")).href)) as Partial<BackgroundTasksInternals>;
    if (typeof runtime.stopTask !== "function") return undefined;
    if (typeof registry.listActiveMetasForOrigin !== "function") return undefined;
    return { stopTask: runtime.stopTask, listActiveMetasForOrigin: registry.listActiveMetasForOrigin };
  } catch (error) {
    debug(`pi-better-background-tasks internals unavailable (${String(error)}); stop will not cancel tasks`);
    return undefined;
  }
}

function originOf(ctx: ExtensionContext): TaskOrigin {
  let sessionId: string | undefined;
  try {
    sessionId = ctx.sessionManager?.getSessionId();
  } catch {
    sessionId = undefined;
  }
  return { cwd: ctx.cwd, sessionId };
}

/** 只认已知终态；接口缺字段/升级形态未知不能冒充停止成功。 */
function isStopped(meta: TaskMeta | undefined): meta is TaskMeta & { status: "succeeded" | "failed" | "cancelled" | "timed_out" } {
  return meta !== undefined && ["succeeded", "failed", "cancelled", "timed_out"].includes(meta.status ?? "");
}

function notifySafe(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(message, type);
  } catch {
    // UI 异常不影响主流程。
  }
}

/**
 * 顺序停止 origin 下所有活跃任务（registry 已按 cwd+sessionId 过滤）。
 * 成功 = stopTask 返回的 meta 已是终态；undefined / 仍 running / 抛异常都计失败。
 */
async function stopSessionTasks(
  internals: BackgroundTasksInternals,
  pi: ExtensionAPI,
  origin: TaskOrigin,
  source: string,
): Promise<{ ok: number; failed: number; failures: string[] }> {
  const running = internals.listActiveMetasForOrigin(origin) ?? [];
  if (running.length === 0) return { ok: 0, failed: 0, failures: [] };

  let ok = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const meta of running) {
    try {
      const result = await internals.stopTask(pi, meta.id, () => origin);
      if (isStopped(result)) {
        ok += 1;
        debug(`[${source}] stopped ${meta.id}${meta.name ? ` (${meta.name})` : ""} → ${result.status}`);
      } else {
        failed += 1;
        failures.push(`${meta.id}: ${result?.status ?? "状态未知"}${result?.error ? ` (${result.error.slice(0, 300)})` : ""}`);
        debug(`[${source}] stopTask left ${meta.id} running (status=${String(result?.status)})`);
      }
    } catch (error) {
      failed += 1;
      failures.push(`${meta.id}: ${String(error)}`);
      debug(`[${source}] failed to stop ${meta.id}: ${String(error)}`);
    }
  }
  return { ok, failed, failures };
}

export default async function (pi: ExtensionAPI) {
  if (!ENABLED) {
    debug("disabled by PI_STOP_CANCELS_TASKS=0");
    return;
  }
  if (!IS_WINDOWS) {
    debug("non-Windows: not activated");
    return;
  }

  const internals = await loadInternals();

  // 接口不可用时也注册命令：宁可明确告诉用户「停不了」，而不是假装命令不存在。
  pi.registerCommand("bg-stop-all", {
    description: "显式停止本会话正在运行的后台任务（仅空闲时可用）",
    handler: async (_args, ctx) => {
      if (!internals) {
        notifySafe(ctx, "bg-stop-all: pi-better-background-tasks 私有接口不可用，无法停止后台任务", "error");
        return;
      }
      if (!ctx.isIdle()) {
        notifySafe(ctx, "bg-stop-all: agent 正在运行，请先按 stop 或等空闲后再用", "warning");
        return;
      }
      const origin = originOf(ctx);
      if (!origin.sessionId) {
        notifySafe(ctx, "bg-stop-all: 无法确认会话 ID，未取消任何任务；请按明确的 task id 单独停止", "warning");
        return;
      }
      const { ok, failed, failures } = await stopSessionTasks(internals, pi, origin, "bg-stop-all");
      const scopeNote = "";
      if (ok === 0 && failed === 0) {
        notifySafe(ctx, `bg-stop-all: 本会话没有运行中的后台任务${scopeNote}`, "info");
        return;
      }
      notifySafe(
        ctx,
        `bg-stop-all: 成功 ${ok}，失败 ${failed}${failures.length > 0 ? `（${failures.join("；")}）` : ""}${scopeNote}`,
        ok === 0 ? "error" : failed > 0 ? "warning" : "info",
      );
    },
  });

  if (!internals) {
    let warned = false;
    pi.on("session_start", (_event, ctx) => {
      if (warned) return;
      warned = true;
      debug("warned user: pi-better-background-tasks internals unavailable");
      notifySafe(ctx, "后台任务模块不可用：stop 将无法取消后台任务，/bg-stop-all 也已失效（请检查 pi-better-background-tasks 安装）", "warning");
    });
    return;
  }

  debug("loaded; an aborted turn will now cancel this session's running background tasks");

  // session_shutdown（关 pi-web / 会话销毁 / 空闲回收）会触发一次 abort，但那不是用户 stop：
  // 之后被 abort 的轮次一律不杀任务，保住 durable 语义。
  let sessionIsTornDown = false;
  pi.on("session_shutdown", async () => {
    sessionIsTornDown = true;
    debug("session_shutdown: further aborted turns will not kill tasks");
  });

  let warnedNoSessionId = false;

  pi.on("agent_end", async (_event, ctx) => {
    // 唯一判据：当前轮的 abort signal。正常完成（aborted=false）与任何消息形态都不触发。
    if (ctx.signal?.aborted !== true) return;
    if (sessionIsTornDown) {
      debug("aborted, but the session is tearing down — leaving background tasks alone");
      return;
    }

    const origin = originOf(ctx);
    if (!origin.sessionId) {
      // 无法确认会话归属：同目录无 sessionId 的任务可能属于别的会话，保守地一个都不取消。
      if (!warnedNoSessionId) {
        warnedNoSessionId = true;
        notifySafe(ctx, "stop 无法确认会话 ID：为避免误伤，本次未取消任何后台任务", "warning");
      }
      debug("aborted but sessionId unavailable — not cancelling tasks (conservative)");
      return;
    }

    const { failed } = await stopSessionTasks(internals, pi, origin, "stop");
    if (failed > 0) {
      notifySafe(ctx, `stop: ${failed} 个后台任务未停掉（仍 running 或出错）`, "warning");
    }
  });
}
