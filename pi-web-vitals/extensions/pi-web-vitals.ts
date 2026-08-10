/**
 * pi-web-vitals.ts
 *
 * 全局扩展：对 pi-web 的可视化增强（Pi Web Vitals）
 * 描述：对 pi-web 可视化项的扩展（缓存命中率、MCP 状态可视化、用户人设注入）
 *
 * 功能：
 *  1. 缓存命中率 CHR = 缓存读取 / (输入 + 缓存读取)（单位 token）
 *     - 累积每轮 assistant 消息的 usage，实时计算
 *     - 通过 setStatus 推送到 pi-web 底部的扩展状态栏
 *     - /cache-stats 命令查看输入/输出/缓存读取/缓存写入/命中率明细
 *
 *  2. MCP 可视化（配合 pi-mcp-adapter 使用）
 *     - 读取标准 MCP 配置文件（.mcp.json、~/.pi/agent/mcp.json、.pi/mcp.json 等）
 *     - 在 pi-web 编辑器上方以 widget 展示各 MCP server 的来源与启停状态
 *     - /mcp-ui 命令：列出 server、启用/禁用（写 .pi/mcp.json 的 disabled 字段，与
 *       pi-mcp-adapter 同一套机制，不冲突）
 *     - 若已安装 pi-mcp-adapter，额外订阅其 MCP_STATUS_EVENT 获取实时状态快照
 *
 *  3. 用户人设注入（global 等级）
 *     - 读取 ~/.pi/agent/persona.md（用户的人设、对话要求等）
 *     - 在 before_agent_start 时追加到系统提示词，全局生效、每轮稳定注入
 *     - 首次运行自动创建模板文件；/persona 命令查看/设置
 *
 * 安装：把本文件放到 ~/.pi/agent/extensions/，然后在 pi-web 里 /reload 或新开会话。
 * 注意：project 级 .pi/ 资源需要先信任项目。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ============================================================================
// 常量
// ============================================================================
const AGENT_DIR = join(homedir(), ".pi", "agent");
const PERSONA_PATH = join(AGENT_DIR, "persona.md");

/** 扩展名（显示在 widget/状态栏） */
const EXT_NAME = "pi-web-vitals";
const STATUS_KEY_CACHE = "pi-vitals-cache";   // 状态栏 key：缓存命中率
const STATUS_KEY_MCP = "pi-vitals-mcp";       // 状态栏 key：MCP 摘要
const WIDGET_KEY = "pi-web-vitals";           // widget key：MCP 状态面板

/** MCP 配置文件优先级（高 → 低），与 pi-mcp-adapter 一致 */
const MCP_CONFIG_FILES = (cwd: string) => [
  join(homedir(), ".config", "mcp", "mcp.json"),     // 用户级全局共享
  join(homedir(), ".agents", "mcp.json"),            // 跨工具全局
  join(homedir(), ".agents", "mcp", "mcp.json"),     // 跨工具全局
  join(AGENT_DIR, "mcp.json"),                       // pi 全局覆盖
  join(cwd, ".mcp.json"),                            // 项目级共享
  join(cwd, ".pi", "mcp.json"),                      // pi 项目覆盖（最高优先写层）
];

const PERSONA_TEMPLATE = `# 我的用户画像（Persona）

> 该文件会被追加到系统提示词末尾，全局生效。
> 在这里描述你的身份、对话风格、工作习惯与要求。每轮对话都会注入，别写太多。

## 我是谁
（例：资深后端工程师，负责 xxx 项目的架构与维护）

## 对话要求
（例：回答使用中文；优先给出可运行代码；解释要简洁直接）

## 工作习惯
（例：改动前先列出影响文件；重要操作先确认；提交信息用 Conventional Commits）

## 其他偏好
（例：不要过度设计；保持接口兼容）
`;

// ============================================================================
// 运行状态（全局累积）
// ============================================================================
interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
let lastUi: ExtensionContext["ui"] | undefined;
let lastCwd = "";
let mcpSnapshot: unknown = undefined; // pi-mcp-adapter 的实时快照（可选）

// ============================================================================
// 工具函数
// ============================================================================
function cacheHitRate(): string {
  const denom = totals.input + totals.cacheRead;
  if (denom <= 0) return "-";
  const rate = (totals.cacheRead / denom) * 100;
  return `${rate.toFixed(1)}%`;
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

function statusLine(): string {
  return `缓存命中率 ${cacheHitRate()} · 输入 ${fmt(totals.input)} · 输出 ${fmt(totals.output)} · 缓存读 ${fmt(totals.cacheRead)} · 缓存写 ${fmt(totals.cacheWrite)}`;
}

// ---- 人设文件 ----
function ensurePersonaFile(): void {
  if (!existsSync(PERSONA_PATH)) {
    try {
      mkdirSync(dirname(PERSONA_PATH), { recursive: true });
      writeFileSync(PERSONA_PATH, PERSONA_TEMPLATE, "utf8");
    } catch {
      /* 忽略写文件失败 */
    }
  }
}

function readPersona(): string {
  try {
    if (!existsSync(PERSONA_PATH)) return "";
    const text = readFileSync(PERSONA_PATH, "utf8").trim();
    // 去掉模板占位说明行（以 ">" 开头的注释和模板标题），只注入真正的内容
    return text
      .replace(/^#\s*我的用户画像.*$/m, "")
      .replace(/^>.*$/gm, "")
      .trim();
  } catch {
    return "";
  }
}

// ---- MCP 配置解析 ----
interface McpServerInfo {
  name: string;
  source: string;       // 配置来源文件
  disabled: boolean;
  kind: string;         // command | url | socket
  target: string;
}

function loadMcpServers(cwd: string): McpServerInfo[] {
  const map = new Map<string, { source: string; def: Record<string, unknown> }>();
  for (const file of MCP_CONFIG_FILES(cwd)) {
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as {
        mcpServers?: Record<string, Record<string, unknown>>;
      };
      if (!data.mcpServers) continue;
      for (const [name, def] of Object.entries(data.mcpServers)) {
        // 优先级高的文件覆盖低的
        if (!map.has(name)) map.set(name, { source: file, def });
      }
    } catch {
      /* 忽略解析失败的配置文件 */
    }
  }
  const out: McpServerInfo[] = [];
  for (const [name, { source, def }] of map) {
    const cmd = typeof def.command === "string" ? def.command : "";
    const url = typeof def.url === "string" ? def.url : "";
    const sock = typeof def.socket === "string" ? def.socket : "";
    out.push({
      name,
      source,
      disabled: def.disabled === true,
      kind: sock ? "socket" : url ? "url" : "command",
      target: sock || url || cmd || "(未配置可执行)",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function setServerDisabled(cwd: string, name: string, disabled: boolean): void {
  const p = join(cwd, ".pi", "mcp.json");
  let data: { mcpServers?: Record<string, Record<string, unknown>> } = {};
  if (existsSync(p)) {
    try {
      data = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      data = {};
    }
  }
  data.mcpServers ??= {};
  data.mcpServers[name] ??= {};
  if (disabled) data.mcpServers[name].disabled = true;
  else delete data.mcpServers[name].disabled;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// ---- UI 推送 ----
function pushCacheStatus(ui?: ExtensionContext["ui"]): void {
  const u = ui ?? lastUi;
  if (!u) return;
  try {
    u.setStatus(STATUS_KEY_CACHE, statusLine());
  } catch {
    /* ignore */
  }
}

function pushMcpWidget(ui?: ExtensionContext["ui"], cwd = lastCwd): void {
  const u = ui ?? lastUi;
  if (!u) return;
  const servers = loadMcpServers(cwd);
  const lines: string[] = [`[${EXT_NAME}] MCP 服务器（共 ${servers.length} 个）`];
  if (servers.length === 0) {
    lines.push("  未配置 MCP 服务器。可创建 .mcp.json 或 ~/.pi/agent/mcp.json");
  } else {
    for (const s of servers) {
      const flag = s.disabled ? "已禁用" : "已启用";
      lines.push(`  ${flag}  ${s.name}  [${s.kind}] ${s.target}`);
      lines.push(`      来源：${s.source.replace(/\\/g, "/")}`);
    }
    lines.push("  输入 /mcp-ui 查看详情、启用或禁用");
  }
  try {
    u.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
    u.setStatus(STATUS_KEY_MCP, `MCP 服务器 ${servers.length} 个 · 启用 ${servers.filter((s) => !s.disabled).length}`);
  } catch {
    /* ignore */
  }
}

// ============================================================================
// 扩展主体
// ============================================================================
export default async function (pi: ExtensionAPI) {
  ensurePersonaFile();

  // ---------- 事件：人设注入（每轮稳定注入系统提示词） ----------
  pi.on("before_agent_start", (event) => {
    const persona = readPersona();
    if (!persona) return;
    const sep = event.systemPrompt.trimEnd().endsWith("\n\n") ? "" : "\n\n";
    return { systemPrompt: `${event.systemPrompt}${sep}${persona}` };
  });

  // ---------- 事件：usage 累积（缓存命中率） ----------
  pi.on("message_end", (event, ctx) => {
    const u = (event.message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
    if (u) {
      totals.input += u.input ?? 0;
      totals.output += u.output ?? 0;
      totals.cacheRead += u.cacheRead ?? 0;
      totals.cacheWrite += u.cacheWrite ?? 0;
    }
    pushCacheStatus(ctx.ui);
  });

  // 会话开始：刷新 UI 引用 + MCP widget + 缓存命中率初始显示（每会话独立累计）
  pi.on("session_start", (event, ctx) => {
    lastUi = ctx.ui;
    lastCwd = ctx.cwd;
    totals.input = 0;
    totals.output = 0;
    totals.cacheRead = 0;
    totals.cacheWrite = 0;
    pushCacheStatus(ctx.ui);
    pushMcpWidget(ctx.ui, ctx.cwd);
  });

  // agent 结束：再刷一次，确保底栏数据是最终值
  pi.on("agent_end", (_event, ctx) => {
    pushCacheStatus(ctx.ui);
  });

  // 会话结束时清理状态栏
  pi.on("session_shutdown", (_event, ctx) => {
    try {
      ctx.ui.setStatus(STATUS_KEY_CACHE, undefined);
      ctx.ui.setStatus(STATUS_KEY_MCP, undefined);
    } catch {
      /* ignore */
    }
    lastUi = undefined;
  });

  // ---------- 可选：订阅 pi-mcp-adapter 实时状态（未安装则静默跳过） ----------
  try {
    const mod = await import("pi-mcp-adapter").catch(() => null);
    const eventName = (mod as { MCP_STATUS_EVENT?: string } | null)?.MCP_STATUS_EVENT;
    if (eventName && typeof pi.events?.on === "function") {
      pi.events.on(eventName, (snapshot) => {
        mcpSnapshot = snapshot;
        pushMcpWidget();
      });
    }
  } catch {
    /* pi-mcp-adapter 未安装，仅使用配置文件展示 */
  }

  // ---------- 命令：/cache-stats ----------
  pi.registerCommand("cache-stats", {
    description: "查看本次会话 token 用量与缓存命中率（CHR）",
    handler: async (_args, ctx) => {
      const t = totals;
      const denom = t.input + t.cacheRead;
      const chr = denom > 0 ? ((t.cacheRead / denom) * 100).toFixed(1) : "-";
      ctx.ui.notify(
        `输入 ${t.input} · 输出 ${t.output} · 缓存读 ${t.cacheRead} · 缓存写 ${t.cacheWrite}\n` +
        `缓存命中率 CHR = ${chr}%（缓存读 ${t.cacheRead} / 输入+缓存读 ${denom}）`,
        "info",
      );
    },
  });

  // ---------- 命令：/mcp-ui ----------
  pi.registerCommand("mcp-ui", {
    description: "查看/配置 MCP server（列表、启用、禁用）",
    handler: async (args, ctx) => {
      const [verb, name] = args.trim().split(/\s+/, 2);
      const cwd = ctx.cwd;

      if (!verb) {
        const servers = loadMcpServers(cwd);
        if (servers.length === 0) {
          ctx.ui.notify("未配置 MCP server。可创建 .mcp.json 或 ~/.pi/agent/mcp.json", "info");
          return;
        }
        const lines = servers
          .map((s) => `${s.disabled ? "[off]" : "[on ]"} ${s.name} (${s.kind}: ${s.target})`)
          .join("\n");
        ctx.ui.notify(`MCP servers:\n${lines}\n\n/mcp-ui enable <name> 或 /mcp-ui disable <name>`, "info");
        return;
      }

      if ((verb === "enable" || verb === "disable") && name) {
        setServerDisabled(cwd, name, verb === "disable");
        pushMcpWidget(ctx.ui, cwd);
        ctx.ui.notify(`MCP server "${name}" 已${verb === "enable" ? "启用" : "禁用"}（写入 .pi/mcp.json）`, "info");
        return;
      }

      ctx.ui.notify(
        "用法：/mcp-ui          列出 server\n" +
        "      /mcp-ui enable <name>   启用\n" +
        "      /mcp-ui disable <name>  禁用",
        "info",
      );
    },
  });

  // ---------- 命令：/persona ----------
  pi.registerCommand("persona", {
    description: "查看/设置用户人设（~/.pi/agent/persona.md，全局注入）",
    handler: async (args, ctx) => {
      const [verb, ...rest] = args.trim().split(/\s+/);
      if (!verb) {
        const content = readPersona();
        ctx.ui.notify(
          content
            ? `当前人设（${PERSONA_PATH}）：\n${content.slice(0, 400)}${content.length > 400 ? "…" : ""}`
            : `人设为空（文件：${PERSONA_PATH}）。用 /persona set <内容> 设置。`,
          "info",
        );
        return;
      }
      if (verb === "set" && rest.length > 0) {
        mkdirSync(dirname(PERSONA_PATH), { recursive: true });
        writeFileSync(PERSONA_PATH, rest.join(" "), "utf8");
        ctx.ui.notify(`人设已更新：\n${rest.join(" ").slice(0, 200)}`, "info");
        return;
      }
      if (verb === "clear") {
        writeFileSync(PERSONA_PATH, "", "utf8");
        ctx.ui.notify("人设已清空。", "info");
        return;
      }
      if (verb === "path") {
        ctx.ui.notify(`人设文件：${PERSONA_PATH}`, "info");
        return;
      }
      ctx.ui.notify(
        "用法：/persona                查看\n" +
        "      /persona set <内容>    设置\n" +
        "      /persona clear         清空\n" +
        "      /persona path          显示文件路径",
        "info",
      );
    },
  });
}
