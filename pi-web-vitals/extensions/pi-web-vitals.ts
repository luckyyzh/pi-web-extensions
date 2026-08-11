/**
 * pi-web-vitals.ts
 *
 * 全局扩展：对 pi-web 的可视化增强（Pi Web Vitals）
 * 描述：对 pi-web 可视化项的扩展（缓存命中率、MCP 状态可视化、用户人设注入）
 *
 * 功能：
 *  1. 缓存命中率 CHR = 缓存读取 / (输入 + 缓存读取)
 *     - 从持久化的会话记录（ctx.sessionManager）读取 assistant 消息 usage 计算累计，
 *       与 pi-web 右上角 token 栏同源，webUI 重启后不归零
 *     - 通过 setStatus 推送到 pi-web 底部的扩展状态栏（只显示缓存命中率）
 *     - /cache-stats 命令查看当前缓存命中率
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

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
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
// 运行状态
// ============================================================================
let lastUi: ExtensionContext["ui"] | undefined;
let lastSessionManager: ExtensionContext["sessionManager"] | undefined;
let lastCwd = "";
let mcpSnapshot: unknown = undefined; // pi-mcp-adapter 的实时快照（可选）

// ============================================================================
// 工具函数：缓存命中率（与 pi-web 右上角同源：读取持久化会话记录里的 usage）
// ============================================================================
interface CacheStat {
  rate: number | null;
}

function computeCacheHitRate(sessionManager: ExtensionContext["sessionManager"]): CacheStat {
  let input = 0;
  let cacheRead = 0;
  try {
    for (const entry of sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const usage = (entry.message as { usage?: { input?: number; cacheRead?: number } }).usage;
      if (!usage) continue;
      input += usage.input ?? 0;
      cacheRead += usage.cacheRead ?? 0;
    }
  } catch {
    /* 会话不可读时按 0 处理 */
  }
  const denom = input + cacheRead;
  return { rate: denom > 0 ? (cacheRead / denom) * 100 : null };
}

function cacheHitRateText(stat: CacheStat): string {
  return stat.rate === null ? "-" : `${stat.rate.toFixed(1)}%`;
}

function statusLine(stat: CacheStat): string {
  return `缓存命中率 ${cacheHitRateText(stat)}`;
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
  command: string;      // stdio 可执行
  args: string[];       // stdio 参数
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
      command: cmd,
      args: Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === "string") : [],
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

/** 合并所有来源的有效 MCP 配置（高优先级在前，供编辑框显示现有 MCP） */
function effectiveMcpConfig(cwd: string): { mcpServers: Record<string, Record<string, unknown>> } {
  const map = new Map<string, Record<string, unknown>>();
  for (const file of MCP_CONFIG_FILES(cwd)) {
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as {
        mcpServers?: Record<string, Record<string, unknown>>;
      };
      if (!data.mcpServers) continue;
      for (const [name, def] of Object.entries(data.mcpServers)) {
        if (!map.has(name)) map.set(name, def);
      }
    } catch {
      /* 忽略解析失败的配置 */
    }
  }
  return { mcpServers: Object.fromEntries(map) };
}

/** 把配置整体写入项目 .pi/mcp.json */
function writeProjectMcpConfig(cwd: string, data: unknown): void {
  const p = join(cwd, ".pi", "mcp.json");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** 新增/覆盖一个 MCP server 定义（默认写入项目 .pi/mcp.json；global=true 写入 ~/.pi/agent/mcp.json） */
function upsertServer(cwd: string, name: string, def: Record<string, unknown>, globalScope = false): void {
  const p = globalScope ? join(AGENT_DIR, "mcp.json") : join(cwd, ".pi", "mcp.json");
  let data: { mcpServers?: Record<string, Record<string, unknown>> } = {};
  if (existsSync(p)) {
    try {
      data = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      data = {};
    }
  }
  data.mcpServers ??= {};
  data.mcpServers[name] = { ...(data.mcpServers[name] ?? {}), ...def };
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** 从项目 .pi/mcp.json 删除一个 server；返回是否删除成功 */
function removeServer(cwd: string, name: string): boolean {
  const p = join(cwd, ".pi", "mcp.json");
  if (!existsSync(p)) return false;
  try {
    const data: { mcpServers?: Record<string, unknown> } = JSON.parse(readFileSync(p, "utf8"));
    if (!data.mcpServers || !(name in data.mcpServers)) return false;
    delete data.mcpServers[name];
    writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

// ---- UI 推送 ----
function pushCacheStatus(ui?: ExtensionContext["ui"], sessionManager?: ExtensionContext["sessionManager"]): void {
  const u = ui ?? lastUi;
  const sm = sessionManager ?? lastSessionManager;
  if (!u || !sm) return;
  try {
    u.setStatus(STATUS_KEY_CACHE, statusLine(computeCacheHitRate(sm)));
  } catch {
    /* ignore */
  }
}

function pushMcpWidget(ui?: ExtensionContext["ui"], cwd = lastCwd): void {
  const u = ui ?? lastUi;
  if (!u) return;
  const servers = loadMcpServers(cwd);
  // 不在输入框上方（aboveEditor）显示 MCP 面板，只保留状态栏摘要
  try {
    u.setStatus(STATUS_KEY_MCP, `MCP 服务器 ${servers.length} 个 · 启用 ${servers.filter((s) => !s.disabled).length}`);
  } catch {
    /* ignore */
  }
}

// ============================================================================
// MCP 管理面板（内嵌同一窗口，不弹窗）
// ============================================================================

function scopeMcpPath(cwd: string, scope: "project" | "global"): string {
  return scope === "global" ? join(AGENT_DIR, "mcp.json") : join(cwd, ".pi", "mcp.json");
}

function readScopeConfig(
  cwd: string,
  scope: "project" | "global",
): { settings?: Record<string, unknown>; mcpServers?: Record<string, Record<string, unknown>> } {
  const p = scopeMcpPath(cwd, scope);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeScopeConfig(cwd: string, scope: "project" | "global", data: unknown): void {
  const p = scopeMcpPath(cwd, scope);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** stdio 型 MCP 连接测试：spawn → initialize → tools/list */
function runStdioMcpTest(command: string, args: string[]): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn> | undefined;
    let info: { name?: string; version?: string } | undefined;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child?.kill(); } catch { /* */ }
      resolve({ ok: false, detail: "连接超时(20s)" });
    }, 20000);
    try {
      child = spawn([command, ...args].join(" "), [], { shell: true, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    } catch (error) {
      clearTimeout(timer);
      resolve({ ok: false, detail: error instanceof Error ? error.message : String(error) });
      return;
    }
    let buf = "";
    child.stdout?.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          const m = JSON.parse(l);
          if (m.id === 1) {
            info = m.result?.serverInfo;
            child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
            setTimeout(() => {
              child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
            }, 300);
          } else if (m.id === 2) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child?.kill(); } catch { /* */ }
            const tools = Array.isArray(m.result?.tools) ? m.result.tools : [];
            resolve({ ok: true, detail: `连通 · ${info?.name ?? "server"} ${info?.version ?? ""} · ${tools.length} 个工具` });
          }
        } catch { /* 非 JSON 行忽略 */ }
      }
    });
    child.stdin?.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-mcp-test", version: "1.0" } },
      }) + "\n",
    );
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, detail: e.message });
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, detail: `进程退出 code=${code}` });
      }
    });
  });
}

async function testMcpConnection(server: McpServerInfo): Promise<string> {
  try {
    if (server.kind === "url") {
      const res = await fetch(server.target, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-mcp-test", version: "1.0" } },
        }),
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      if (res.ok && text) return `连通 (HTTP ${res.status})`;
      return `HTTP ${res.status}`;
    }
    if (server.kind === "command") {
      const r = await runStdioMcpTest(server.command, server.args);
      return r.ok ? `测试成功 · ${r.detail}` : `测试失败 · ${r.detail}`;
    }
    return `socket 类型暂不支持自动测试`;
  } catch (error) {
    return `测试失败 · ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** 提取可打印字符 / 粘贴内容（bracketed paste） */
function pasteOrChar(data: string): string | null {
  if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) {
    return data.slice("\x1b[200~".length, -"\x1b[201~".length);
  }
  if (data.length === 1 && data.charCodeAt(0) >= 32) return data;
  return null;
}

const OPTS_DEFS: Array<{ key: string; label: string; isNumber: boolean }> = [
  { key: "toolPrefix", label: "toolPrefix（工具前缀）", isNumber: false },
  { key: "requestTimeoutMs", label: "requestTimeoutMs（请求超时ms）", isNumber: true },
  { key: "maxRetries", label: "maxRetries（重连次数）", isNumber: true },
];

class MCPPanel {
  private scope: "project" | "global" = "project";
  private mode: "menu" | "list" | "detail" | "add" | "json" | "opts" | "optsVal" = "menu";
  private servers: McpServerInfo[] = [];
  private detail: McpServerInfo | null = null;
  private status = "";
  // add
  private addStep = 0;
  private addName = "";
  private addSpec = "";
  private addArgs = "";
  private addIsCommand = false;
  // json
  private jsonBuf = "";
  // opts
  private optsSel = 0;
  private optsVal = "";

  constructor(
    private theme: Theme,
    private done: (v: undefined) => void,
    private tui: { requestRender(): void },
    private cwd: string,
  ) {
    this.refresh();
  }

  private refresh(): void {
    this.servers = loadMcpServers(this.cwd);
  }

  private scopeLabel(): string {
    return this.scope === "global" ? "全局(~/.pi/agent/mcp.json)" : "项目(.pi/mcp.json)";
  }

  /** TUI 组件协议要求：终端尺寸变化 / 主题切换时由 pi-web 调用。无缓存状态，空实现即可。 */
  invalidate(): void {
    /* 无缓存状态需要失效 */
  }

  handleInput(data: string): void {
    const esc = matchesKey(data, "escape");

    if (this.mode === "menu") {
      if (esc) return this.done(undefined);
      if (matchesKey(data, "1")) { this.mode = "list"; return; }
      if (matchesKey(data, "2")) { this.mode = "add"; this.addStep = 0; this.addName = ""; this.addSpec = ""; this.addArgs = ""; return; }
      if (matchesKey(data, "3")) { this.mode = "json"; this.jsonBuf = ""; return; }
      if (matchesKey(data, "4")) { this.mode = "opts"; return; }
      if (matchesKey(data, "7")) { this.scope = this.scope === "project" ? "global" : "project"; this.status = `作用域已切换为 ${this.scopeLabel()}`; return; }
      if (matchesKey(data, "0")) { this.refresh(); this.status = "已刷新"; return; }
      return;
    }

    if (this.mode === "list") {
      if (esc || matchesKey(data, "b")) { this.mode = "menu"; return; }
      if (data.length === 1 && data >= "1" && data <= "9") {
        const i = parseInt(data, 10) - 1;
        if (i < this.servers.length) { this.detail = this.servers[i]; this.mode = "detail"; this.status = ""; }
      }
      return;
    }

    if (this.mode === "detail" && this.detail) {
      if (esc || matchesKey(data, "b")) { this.mode = "list"; return; }
      if (matchesKey(data, "e")) { this.setDisabled(false); return; }
      if (matchesKey(data, "d")) { this.setDisabled(true); return; }
      if (matchesKey(data, "t")) { void this.runTest(); return; }
      if (matchesKey(data, "x")) { this.removeDetail(); this.mode = "list"; return; }
      if (matchesKey(data, "l")) { this.toggleLifecycle(); return; }
      if (matchesKey(data, "g")) { this.toggleDirectTools(); return; }
      return;
    }

    if (this.mode === "add") {
      if (esc) { this.mode = "menu"; return; }
      if (matchesKey(data, "return")) {
        if (this.addStep === 0 && this.addName) { this.addStep = 1; return; }
        if (this.addStep === 1) { this.addIsCommand = !/^https?:\/\//.test(this.addSpec.trim()); this.addStep = 2; return; }
        if (this.addStep === 2) { this.commitAdd(); this.mode = "menu"; return; }
        return;
      }
      if (matchesKey(data, "backspace")) {
        if (this.addStep === 0) this.addName = this.addName.slice(0, -1);
        else if (this.addStep === 1) this.addSpec = this.addSpec.slice(0, -1);
        else this.addArgs = this.addArgs.slice(0, -1);
        return;
      }
      const t = pasteOrChar(data);
      if (t) {
        if (this.addStep === 0) this.addName += t;
        else if (this.addStep === 1) this.addSpec += t;
        else this.addArgs += t;
      }
      return;
    }

    if (this.mode === "json") {
      if (esc) { this.mode = "menu"; return; }
      if (matchesKey(data, "return")) { this.commitJson(); this.mode = "menu"; return; }
      if (matchesKey(data, "backspace")) { this.jsonBuf = this.jsonBuf.slice(0, -1); return; }
      const t = pasteOrChar(data);
      if (t) this.jsonBuf += t;
      return;
    }

    if (this.mode === "opts") {
      if (esc || matchesKey(data, "b")) { this.mode = "menu"; return; }
      if (data === "1" || data === "2" || data === "3") { this.optsSel = parseInt(data, 10) - 1; this.optsVal = ""; this.mode = "optsVal"; }
      return;
    }

    if (this.mode === "optsVal") {
      if (esc) { this.mode = "opts"; return; }
      if (matchesKey(data, "return")) { this.commitOpt(); this.mode = "opts"; return; }
      if (matchesKey(data, "backspace")) { this.optsVal = this.optsVal.slice(0, -1); return; }
      const t = pasteOrChar(data);
      if (t) this.optsVal += t;
      return;
    }
  }

  private setDisabled(disabled: boolean): void {
    if (!this.detail) return;
    setServerDisabled(this.cwd, this.detail.name, disabled);
    this.refresh();
    this.detail = this.servers.find((s) => s.name === this.detail?.name) ?? null;
    this.status = `已${disabled ? "禁用" : "启用"} ${this.detail?.name ?? ""}（写 ${this.scopeLabel()}，执行 /reload 生效）`;
  }

  private removeDetail(): void {
    if (!this.detail) return;
    removeServer(this.cwd, this.detail.name);
    this.refresh();
    this.status = `已删除 ${this.detail.name}`;
    this.detail = null;
  }

  private toggleLifecycle(): void {
    if (!this.detail) return;
    const cur = this.detailLifecycle();
    const next = cur === "eager" ? "lazy" : "eager";
    this.patchDetail({ lifecycle: next });
    this.status = `${this.detail.name} 生命周期 → ${next}`;
  }

  private toggleDirectTools(): void {
    if (!this.detail) return;
    const cur = this.detailDirectTools();
    const next = cur === true ? false : true;
    this.patchDetail({ directTools: next });
    this.status = `${this.detail.name} directTools → ${next ? "直连" : "代理"}`;
  }

  private detailLifecycle(): string {
    const def = this.findDef(this.detail?.name);
    return typeof def?.lifecycle === "string" ? def.lifecycle : "lazy";
  }

  private detailDirectTools(): boolean {
    const def = this.findDef(this.detail?.name);
    return def?.directTools === true;
  }

  private findDef(name?: string): Record<string, unknown> | undefined {
    if (!name) return undefined;
    return readScopeConfig(this.cwd, this.scope).mcpServers?.[name];
  }

  private patchDetail(patch: Record<string, unknown>): void {
    if (!this.detail) return;
    const data = readScopeConfig(this.cwd, this.scope);
    data.mcpServers ??= {};
    data.mcpServers[this.detail.name] = { ...(data.mcpServers[this.detail.name] ?? {}), ...patch };
    writeScopeConfig(this.cwd, this.scope, data);
    this.refresh();
    this.detail = this.servers.find((s) => s.name === this.detail?.name) ?? null;
  }

  private commitAdd(): void {
    const name = this.addName.trim();
    const spec = this.addSpec.trim();
    if (!name || !spec) { this.status = "名称或命令/URL 不能为空"; return; }
    const def: Record<string, unknown> = this.addIsCommand
      ? { command: spec.split(/\s+/)[0], args: spec.split(/\s+/).slice(1) }
      : { url: spec };
    const p = scopeMcpPath(this.cwd, this.scope);
    const data = readScopeConfig(this.cwd, this.scope);
    data.mcpServers ??= {};
    data.mcpServers[name] = def;
    writeScopeConfig(this.cwd, this.scope, data);
    this.refresh();
    this.status = `已添加 ${name}（${p}），执行 /reload 生效`;
  }

  private commitJson(): void {
    try {
      const parsed = JSON.parse(this.jsonBuf) as { mcpServers?: unknown };
      const servers = parsed?.mcpServers;
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
        this.status = '格式无效：需要 {"mcpServers": { ... }}';
        return;
      }
      const data = readScopeConfig(this.cwd, this.scope);
      data.mcpServers = servers as Record<string, Record<string, unknown>>;
      writeScopeConfig(this.cwd, this.scope, data);
      this.refresh();
      this.status = `已保存到 ${scopeMcpPath(this.cwd, this.scope)}，执行 /reload 生效`;
    } catch (error) {
      this.status = `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private commitOpt(): void {
    const def = OPTS_DEFS[this.optsSel];
    if (!def) return;
    const data = readScopeConfig(this.cwd, this.scope);
    data.settings ??= {};
    if (def.isNumber) {
      const n = Number(this.optsVal);
      if (Number.isFinite(n)) data.settings[def.key] = n;
    } else {
      data.settings[def.key] = this.optsVal;
    }
    writeScopeConfig(this.cwd, this.scope, data);
    this.refresh();
    this.status = `已设置 ${def.key}=${this.optsVal}`;
  }

  private async runTest(): Promise<void> {
    const s = this.detail;
    if (!s) return;
    this.status = `正在测试 ${s.name} ...`;
    this.tui.requestRender();
    const result = await testMcpConnection(s);
    this.status = `${s.name} · ${result}`;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const w = Math.max(width, 40);
    const box = (s: string): string => (s.length > w - 2 ? s.slice(0, w - 5) + "…" : s);
    const sep = "─".repeat(Math.min(w - 2, 60));
    const lines: string[] = [];

    if (this.mode === "menu") {
      lines.push("MCP 管理面板");
      lines.push(sep);
      lines.push(`作用域: ${this.scopeLabel()}   [7 切换]`);
      lines.push("  [1] 服务器列表 / 详情 / 启停 / 测试连接");
      lines.push("  [2] 添加服务器（引导式）");
      lines.push("  [3] 编辑 JSON（粘贴整份后回车）");
      lines.push("  [4] pi-mcp-adapter 选项");
      lines.push("  [0] 刷新");
      lines.push(sep);
      lines.push(`[Esc] 关闭    ${this.status ? `状态: ${box(this.status)}` : ""}`);
      return lines;
    }

    if (this.mode === "list") {
      lines.push(`MCP 服务器列表（${this.servers.length} 个）`);
      lines.push(sep);
      if (this.servers.length === 0) {
        lines.push("  暂无服务器。返回按 [2] 添加。");
      } else {
        this.servers.forEach((s, i) => {
          lines.push(`  ${i + 1}. ${s.disabled ? "[禁用]" : "[启用]"} ${s.name}  (${s.kind}) ${box(s.target)}`);
        });
      }
      lines.push(sep);
      lines.push(`[1-9] 查看/操作  [b/Esc] 返回`);
      return lines;
    }

    if (this.mode === "detail" && this.detail) {
      const d = this.detail;
      lines.push(`服务器: ${d.name}`);
      lines.push(sep);
      lines.push(`  状态: ${d.disabled ? "已禁用" : "已启用"}`);
      lines.push(`  类型: ${d.kind}`);
      lines.push(`  命令/URL: ${box(d.target)}`);
      lines.push(`  生命周期: ${this.detailLifecycle()}   directTools: ${this.detailDirectTools() ? "直连" : "代理"}`);
      lines.push(`  来源: ${box(d.source.replace(/\\/g, "/"))}`);
      lines.push(sep);
      lines.push("  [e] 启用  [d] 禁用  [t] 测试连接  [l] 切换生命周期  [g] 直连/代理  [x] 删除");
      lines.push(`  [b/Esc] 返回    ${this.status ? box(this.status) : ""}`);
      return lines;
    }

    if (this.mode === "add") {
      lines.push(`添加服务器（引导式）  作用域: ${this.scopeLabel()}`);
      lines.push(sep);
      if (this.addStep === 0) lines.push(`  第 1/3 步 · 名称: ${this.addName}█`);
      else if (this.addStep === 1) lines.push(`  名称: ${this.addName}\n  第 2/3 步 · 命令或 URL: ${this.addSpec}█`);
      else lines.push(`  名称: ${this.addName}  命令/URL: ${this.addSpec}\n  第 3/3 步 · 参数(空格分隔, 可空): ${this.addArgs}█`);
      lines.push(sep);
      lines.push(`[Enter] 下一步/完成  [Backspace] 删除  [Esc] 取消`);
      return lines;
    }

    if (this.mode === "json") {
      lines.push("编辑 MCP 配置（JSON）  [Esc] 返回");
      lines.push(sep);
      lines.push("当前生效配置:");
      const effective = JSON.stringify(effectiveMcpConfig(this.cwd), null, 2);
      for (const l of effective.split("\n")) lines.push("  " + box(l));
      lines.push(sep);
      lines.push("粘贴新的完整 JSON（含 mcpServers）后回车应用:");
      lines.push("  " + box(this.jsonBuf) + "█");
      lines.push(sep);
      lines.push(this.status ? box(this.status) : "");
      return lines;
    }

    if (this.mode === "opts") {
      lines.push("pi-mcp-adapter 选项（写入作用域配置的 settings）");
      lines.push(sep);
      const data = readScopeConfig(this.cwd, this.scope);
      OPTS_DEFS.forEach((d, i) => {
        const v = data.settings?.[d.key] ?? "(未设置)";
        lines.push(`  ${i + 1}. ${d.label}: ${box(String(v))}`);
      });
      lines.push(sep);
      lines.push(`[1-3] 编辑  [b/Esc] 返回    ${this.status ? box(this.status) : ""}`);
      return lines;
    }

    if (this.mode === "optsVal") {
      const d = OPTS_DEFS[this.optsSel];
      lines.push(`编辑 ${d?.label ?? ""}（${this.scopeLabel()}）`);
      lines.push(sep);
      const cur = readScopeConfig(this.cwd, this.scope).settings?.[d?.key ?? ""] ?? "(未设置)";
      lines.push(`  当前: ${box(String(cur))}`);
      lines.push(`  输入新值回车（空=不修改）: ${this.optsVal}█`);
      lines.push(`[Enter] 保存  [Esc] 取消`);
      return lines;
    }

    return lines;
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

  // 会话开始：刷新引用 + 从持久化会话记录计算缓存命中率（重启后不归零）+ MCP widget
  pi.on("session_start", (_event, ctx) => {
    lastUi = ctx.ui;
    lastSessionManager = ctx.sessionManager;
    lastCwd = ctx.cwd;
    pushCacheStatus(ctx.ui, ctx.sessionManager);
    pushMcpWidget(ctx.ui, ctx.cwd);
  });

  // agent 结束：从会话记录重算，确保底栏数据是最新值
  pi.on("agent_end", (_event, ctx) => {
    pushCacheStatus(ctx.ui, ctx.sessionManager);
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
    description: "查看本次会话缓存命中率",
    handler: async (_args, ctx) => {
      const stat = computeCacheHitRate(ctx.sessionManager);
      ctx.ui.notify(`缓存命中率 ${cacheHitRateText(stat)}`, "info");
    },
  });

  // ---------- 命令：/mcp-ui（查看 / 添加 / 删除 / 启用 / 禁用） ----------
  pi.registerCommand("mcp-ui", {
    description: "查看/配置 MCP server（无配置时引导添加，或 add/remove/enable/disable）",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const verb = parts[0];
      const cwd = ctx.cwd;

      const list = () => {
        const servers = loadMcpServers(cwd);
        if (servers.length === 0) {
          ctx.ui.notify("未配置 MCP 服务器。输入 /mcp-ui 打开配置框添加。", "info");
          return;
        }
        const lines = servers
          .map((s) => `${s.disabled ? "[已禁用]" : "[已启用]"} ${s.name} (${s.kind}: ${s.target})`)
          .join("\n");
        ctx.ui.notify(`MCP 服务器（${servers.length} 个）：\n${lines}\n\n/mcp-ui enable <名称> 或 /mcp-ui disable <名称>`, "info");
      };

      // 无参数：打开内嵌的 MCP 管理面板（同一窗口，不弹窗）
      if (!verb) {
        await ctx.ui.custom<void>(
          (tui, theme, _kb, done) => new MCPPanel(theme, done, tui, cwd),
          { overlay: true },
        );
        pushMcpWidget(ctx.ui, cwd);
        return;
      }

      if (verb === "add") {
        let globalScope = false;
        let i = 1;
        if (parts[1] === "-g") {
          globalScope = true;
          i = 2;
        }
        const name = parts[i];
        const rest = parts.slice(i + 1).join(" ");
        if (!name || !rest) {
          ctx.ui.notify("用法：/mcp-ui add <名称> <命令或URL> [参数...]，如 /mcp-ui add chrome-devtools npx -y chrome-devtools-mcp（加 -g 写入全局）", "info");
          return;
        }
        const def = /^https?:\/\//.test(rest)
          ? { url: rest }
          : { command: rest.split(/\s+/)[0], args: rest.split(/\s+/).slice(1) };
        upsertServer(cwd, name, def, globalScope);
        pushMcpWidget(ctx.ui, cwd);
        ctx.ui.notify(
          `已添加 MCP 服务器 "${name}"（写入 ${globalScope ? "~/.pi/agent/mcp.json" : ".pi/mcp.json"}）。执行 /reload 生效。`,
          "info",
        );
        return;
      }

      if (verb === "remove" && parts[1]) {
        const ok = removeServer(cwd, parts[1]);
        pushMcpWidget(ctx.ui, cwd);
        ctx.ui.notify(ok ? `已删除 MCP 服务器 "${parts[1]}"。` : `未找到 "${parts[1]}"。`, ok ? "info" : "warning");
        return;
      }

      if ((verb === "enable" || verb === "disable") && parts[1]) {
        setServerDisabled(cwd, parts[1], verb === "disable");
        pushMcpWidget(ctx.ui, cwd);
        ctx.ui.notify(`MCP 服务器 "${parts[1]}" 已${verb === "enable" ? "启用" : "禁用"}（写入 .pi/mcp.json）。执行 /reload 生效。`, "info");
        return;
      }

      if (verb === "list") {
        list();
        return;
      }

      ctx.ui.notify(
        "用法：\n  /mcp-ui                      打开编辑框（显示已有 MCP，可增删改）\n" +
          "  /mcp-ui list                  查看列表\n" +
          "  /mcp-ui add <名称> <命令或URL> [参数...]   快速添加（加 -g 写入全局）\n" +
          "  /mcp-ui remove <名称>         删除\n" +
          "  /mcp-ui enable|disable <名称>  启用/禁用",
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
