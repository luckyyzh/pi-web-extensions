/**
 * background-task-reaper.ts —— 自动恢复「僵尸」后台任务的真实终态（仅 Windows）
 *
 * 僵尸：发起的 pi 进程死后没人给任务收尾，记录永远停在 running。
 *
 * 行为：
 *   - 每轮 agent_start/agent_end/turn_start、每次 bg_task_* 工具返回后扫一遍本会话活跃任务
 *   - 跳过 remote（本地 pid 只是 ssh 客户端，退出≠任务结束）和 command_watch
 *     （每轮轮询是新进程，meta 没有稳定的任务 pid）
 *   - 本地 process 任务 pid 连判两次消失后，调用 bg-tasks 私有同步接口
 *     reconcileTask(pi, id, getActiveSession?)：它只读 meta 恢复真实终态
 *     （日志有 self-exit code → 真实 succeeded/failed；无证据 → failed 且
 *     result-unavailable），绝不杀任何进程。取代旧版「stopTask 冒充归档」
 *     （那会把结果写死成 cancelled、丢掉真实退出码）
 *   - 只有 reconcileTask 返回终态（status 不再是 running）才计为已收割；
 *     返回 running/未知状态不计，下次重新开始两次观察
 *   - 小锁防 sweep 重入；session_shutdown 只清底部栏，不修改任何任务
 *
 * 底部栏：`N个正在运行 · M个僵尸任务已恢复`（STATUS_KEY="后台任务"）。
 *
 * 降级（对用户可见，不只是 debug）：
 *   - 私有模块整体不可用：session_start 明确警告，模块停用
 *   - 缺 runtime.reconcileTask（包未升级）：session_start 明确警告，退化为仅显示
 *
 * 范围：仅 Windows 激活（reconcileTask 也只处理 Windows 本地进程）；非 Windows 整体不启用。
 * 环境变量：PI_BG_REAPER=0 关闭；PI_BG_REAPER_DEBUG=1 或哨兵文件 <tmp>/pi-bg-reaper.debug
 *   打开日志（追加到 <tmp>/pi-bg-reaper.log）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ENABLED = process.env.PI_BG_REAPER !== "0";
const IS_WINDOWS = process.platform === "win32";
const DEBUG_ENV = process.env.PI_BG_REAPER_DEBUG === "1";
const DEBUG_FLAG_FILE = join(tmpdir(), "pi-bg-reaper.debug");
const DEBUG_LOG_FILE = join(tmpdir(), "pi-bg-reaper.log");

/** 底部栏状态项的 key（渲染成 "后台任务" + 计数文本） */
const STATUS_KEY = "后台任务";

type TaskOrigin = { cwd: string; sessionId?: string };

type TaskMeta = {
  id: string;
  name?: string;
  status?: string;
  kind?: string;
  pid?: number;
  remote?: unknown;
};

type ReconcileFn = (pi: ExtensionAPI, id: string, getActiveSession?: () => TaskOrigin) => TaskMeta | undefined;

function debug(message: string): void {
  if (!DEBUG_ENV && !existsSync(DEBUG_FLAG_FILE)) return;
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    if (DEBUG_ENV) process.stderr.write(`[pi-bg-reaper] ${message}\n`);
    appendFileSync(DEBUG_LOG_FILE, line);
  } catch {
    /* 日志不可用就算了，不能因为排查通道挂了影响主流程 */
  }
}

/**
 * bg-tasks 私有模块（有意破例复用）。list 拿不到则整体停用；reconcile 拿不到
 * 则退化为仅显示 —— 都走用户可见警告（load 结果里的 problem）。
 */
async function loadInternals(): Promise<{
  list: ((origin: TaskOrigin) => TaskMeta[]) | undefined;
  reconcile: ReconcileFn | undefined;
  problem: string | undefined;
}> {
  try {
    const src = join(getAgentDir(), "npm", "node_modules", "pi-better-background-tasks", "src");
    const runtime = (await import(pathToFileURL(join(src, "runtime.ts")).href)) as { reconcileTask?: ReconcileFn };
    const registry = (await import(pathToFileURL(join(src, "registry.ts")).href)) as {
      listActiveMetasForOrigin?: (origin: TaskOrigin) => TaskMeta[];
    };
    const list = typeof registry.listActiveMetasForOrigin === "function" ? registry.listActiveMetasForOrigin : undefined;
    const reconcile = typeof runtime.reconcileTask === "function" ? runtime.reconcileTask : undefined;
    if (!list) return { list: undefined, reconcile: undefined, problem: "registry.listActiveMetasForOrigin 缺失，收割器停用" };
    if (!reconcile) return { list, reconcile: undefined, problem: "runtime.reconcileTask 缺失（包未升级？），自动恢复停用，仅保留底部栏显示" };
    return { list, reconcile, problem: undefined };
  } catch (error) {
    return { list: undefined, reconcile: undefined, problem: `pi-better-background-tasks 私有接口不可用：${String(error)}` };
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

function notifySafe(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(message, type);
  } catch {
    // UI 异常不影响主流程。
  }
}

/** pid 还在不在。EPERM = 进程存在但没权限，也算活着。 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
}

/** 这个任务算不算僵尸？返回原因字符串（写日志用），不算就返回 undefined。 */
function zombieReason(meta: TaskMeta): string | undefined {
  if (meta.remote) return undefined;
  if (meta.kind === "command_watch") return undefined;
  if (typeof meta.pid !== "number" || meta.pid <= 0) return undefined;
  return isProcessAlive(meta.pid) ? undefined : `pid ${meta.pid} is gone`;
}

export default async function (pi: ExtensionAPI) {
  if (!ENABLED) {
    debug("disabled by PI_BG_REAPER=0");
    return;
  }
  if (!IS_WINDOWS) {
    debug("non-Windows: not activated");
    return;
  }

  const { list, reconcile, problem } = await loadInternals();

  if (problem) {
    let warned = false;
    pi.on("session_start", (_event, ctx) => {
      if (warned) return;
      warned = true;
      debug(`warned user: ${problem}`);
      notifySafe(ctx, `后台任务收割器不可用：${problem}`, "warning");
    });
  }
  if (!list) {
    debug(`reaper disabled: ${problem}`);
    return;
  }
  if (problem) {
    debug(`reaper degraded (list-only): ${problem}`);
  } else {
    debug("loaded; zombie background tasks of this session will be reconciled automatically");
  }

  const listTasks = list; // Preserve narrowing across the nested async sweep.
  /** 本会话累计收割数（底部栏上的 m） */
  let reapedTotal = 0;
  /** 上一次扫描看到的运行中任务数（底部栏上的 n） */
  let runningTotal = 0;
  /** 已经"看到死过一次"的任务 id，连看两次才动手 */
  const suspects = new Set<string>();
  /** 小锁：sweep 重入直接跳过（不排队），防止事件交错时重复处理 */
  let sweepInFlight = false;

  function render(ctx: ExtensionContext): void {
    // 常驻底部栏：0/0 也显示，随时可瞄一眼的信任信号。
    ctx.ui.setStatus(STATUS_KEY, `${runningTotal}个正在运行 · ${reapedTotal}个僵尸任务已恢复`);
  }

  async function sweep(ctx: ExtensionContext): Promise<void> {
    if (sweepInFlight) return;
    sweepInFlight = true;
    try {
      const origin = originOf(ctx);
      const running = listTasks(origin) ?? [];

      if (!reconcile) {
        // 缺 reconcileTask：只刷新显示，不做任何判定（避免无接口可调用时空转）
        runningTotal = running.length;
        render(ctx);
        return;
      }

      const ids = new Set(running.map((meta) => meta.id));
      // 已经不在运行列表里的（结束了/别的会话处理的），忘掉嫌疑标记
      for (const id of [...suspects]) if (!ids.has(id)) suspects.delete(id);

      let reapedNow = 0;
      for (const meta of running) {
        let reason: string | undefined;
        try {
          reason = zombieReason(meta);
        } catch (error) {
          debug(`liveness check failed for ${meta.id}: ${String(error)}`);
          continue;
        }
        if (!reason) {
          suspects.delete(meta.id);
          continue;
        }
        if (!suspects.has(meta.id)) {
          // 第一次看到 pid 消失：先记上，下一次扫描仍消失才动手
          suspects.add(meta.id);
          debug(`suspect ${meta.id}${meta.name ? ` (${meta.name})` : ""} — ${reason}`);
          continue;
        }
        // 连判两次死亡：恢复真实终态（reconcileTask 绝不杀进程）
        let result: TaskMeta | undefined;
        try {
          result = reconcile(pi, meta.id, () => origin);
        } catch (error) {
          debug(`reconcileTask failed for ${meta.id}: ${String(error)}`);
          suspects.delete(meta.id);
          continue;
        }
        if (!result) {
          debug(`reconcileTask returned nothing for ${meta.id}`);
          suspects.delete(meta.id);
          continue;
        }
        if (!["succeeded", "failed", "cancelled", "timed_out"].includes(result.status ?? "")) {
          // 没能恢复或接口结果未知：不计收割，下一次重新观察
          suspects.delete(meta.id);
          debug(`reconcile left ${meta.id} running — not reaped`);
          continue;
        }
        // 终态：已恢复成真实 succeeded/failed 等，计为已收割
        suspects.delete(meta.id);
        reapedNow += 1;
        reapedTotal += 1;
        debug(`reaped ${meta.id}${meta.name ? ` (${meta.name})` : ""} — ${reason} → ${result.status}`);
      }

      runningTotal = Math.max(0, running.length - reapedNow);
      render(ctx);
    } catch (error) {
      debug(`sweep failed: ${String(error)}`);
    } finally {
      sweepInFlight = false;
    }
  }

  // 频率：每轮 agent 开始/结束、每次 LLM 轮次开始、每次 bg_task_* 工具返回后。
  // 本扩展不再另建定时器；runtime 已复用日志维护计时器观察恢复后的本地进程。
  pi.on("agent_start", async (_event, ctx) => {
    await sweep(ctx);
  });
  pi.on("agent_end", async (_event, ctx) => {
    await sweep(ctx);
  });
  pi.on("turn_start", async (_event, ctx) => {
    await sweep(ctx);
  });
  pi.on("tool_result", async (event, ctx) => {
    const toolName = typeof event.toolName === "string" ? event.toolName : "";
    if (toolName.startsWith("bg_task")) await sweep(ctx);
  });

  // 关会话：只清底部栏，不修改任何任务（durable 语义）。
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      /* 关会话时清底栏失败无所谓 */
    }
  });
}
