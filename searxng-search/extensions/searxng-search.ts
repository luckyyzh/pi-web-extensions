/**
 * searxng-search.ts
 *
 * 全局扩展：通过自建 SearXNG 端点提供网络搜索 + 网页抓取能力
 * 工具：
 *   web_search  使用私有 SearXNG 实例（GET /search-api/search + X-Search-Token）
 *   web_fetch   抓取静态网页并返回正文纯文本（不支持 JS 渲染页面，那些用 agent_browser）
 *
 * 接入契约（与你的服务端一致）：
 *   端点  GET https://llm-local.cloud/search-api/search
 *   鉴权  HTTP 头 X-Search-Token: <token>（token 读环境变量 SEARXNG_TOKEN）
 *   参数  q(必填) format=json(固定) engines/language/pageno/time_range(可选)
 *   返回  { results: [{ title, url, content, engine, score, publishedDate }],
 *           answers, corrections, suggestions, infoboxes, unresponsive_engines }
 *
 * 安装：放到 ~/.pi/agent/extensions/，然后 /reload 或新开会话。
 * 环境变量：SEARXNG_URL（默认 https://llm-local.cloud/search-api/search）、SEARXNG_TOKEN
 * 也可用 /web-search config 持久化 url/token（覆盖环境变量）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";

// ============================================================================
// 常量与配置
// ============================================================================
const DEFAULT_URL = "https://llm-local.cloud/search-api/search";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "searxng-config.json");
const REQUEST_TIMEOUT_MS = 20_000; // 服务端抓取超时 10s，客户端留 20s
const RETRY_DELAY_MS = 1_500; // 网络错误 / 429 / 5xx 重试前延迟
const CACHE_TTL_MS = 5 * 60_000; // 内存缓存 5 分钟
const CACHE_MAX_ENTRIES = 100; // 缓存条数上限（超出按写入时间淘汰最旧）
const CACHE_MAX_RESULTS = 40; // 缓存中 results 最多保存条数
const FETCH_MAX_BODY_BYTES = 4 * 1024 * 1024; // web_fetch 响应体上限 4MB
const MAX_FETCH_CHARS_DEFAULT = 20_000;
const MAX_FETCH_CHARS_LIMIT = 50_000;

interface SearchConfig {
  url?: string;
  token?: string;
}

function loadConfig(): SearchConfig {
  let file: Partial<SearchConfig> = {};
  try {
    if (existsSync(CONFIG_PATH)) file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    file = {};
  }
  return {
    url: file.url ?? process.env.SEARXNG_URL ?? DEFAULT_URL,
    token: file.token ?? process.env.SEARXNG_TOKEN,
  };
}

function saveConfig(partial: Partial<SearchConfig>): SearchConfig {
  const next: SearchConfig = { ...loadConfig(), ...partial };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

// ============================================================================
// 网络请求（尊重 HTTP(S)_PROXY 环境变量）
// ============================================================================
async function createFetch(): Promise<typeof fetch> {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxy) return fetch;
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(proxy));
  } catch {
    /* 忽略：无 undici 则用裸 fetch */
  }
  return fetch;
}

// ============================================================================
// 通用小工具
// ============================================================================
/** 调用方取消信号触发时抛出（execute 捕获后返回"已取消"） */
class CancelledError extends Error {
  constructor() {
    super("已取消");
    this.name = "CancelledError";
  }
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "TimeoutError" || /aborted due to timeout/i.test(err.message);
}

/** 可被调用方信号中断的 sleep */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(onAbort, ms);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** 组合 20s 超时与调用方信号（调用方已 abort 则立即 abort） */
function combineSignals(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) return timeout;
  if (caller.aborted) {
    const ctrl = new AbortController();
    ctrl.abort(caller.reason);
    return ctrl.signal;
  }
  if (typeof AbortSignal.any === "function") return AbortSignal.any([timeout, caller]);
  // 兜底：手动转发 abort
  const ctrl = new AbortController();
  const forward = (sig: AbortSignal) => () => {
    if (!ctrl.signal.aborted) ctrl.abort(sig.reason);
  };
  timeout.addEventListener("abort", forward(timeout), { once: true });
  caller.addEventListener("abort", forward(caller), { once: true });
  return ctrl.signal;
}

async function cancelResponseBody(res: Response): Promise<void> {
  if (!res.body) return;
  try {
    await res.body.cancel();
  } catch {
    /* ignore */
  }
}

// ============================================================================
// 调用 SearXNG（含重试与错误文案）
// ============================================================================
interface SearchParams {
  query: string;
  engines?: string;
  language?: string;
  pageno?: number;
  timeRange?: string;
  maxResults: number;
}

interface SearchItem {
  title: string;
  url: string;
  content: string;
  engine: string;
  publishedDate?: string;
  score?: number;
}

interface SearxngInfobox {
  title: string;
  content: string;
}

interface SearxngResponse {
  /** 已按规范化 URL 去重，最多 CACHE_MAX_RESULTS 条 */
  results: SearchItem[];
  answers: string[];
  corrections: string[];
  suggestions: string[];
  infobox: SearxngInfobox | null;
  /** 每项形如 "name(error)" */
  unresponsive: string[];
}

/**
 * URL 规范化：host 小写、去 fragment、去末尾斜杠、去掉 utm_* 查询参数。
 * 解析失败则原样返回（仍可用于去重比较）。
 */
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    for (const key of [...u.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) u.searchParams.delete(key);
    }
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return raw;
  }
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** 解析 SearXNG JSON：去重 + 裁剪到 maxResults 条 + 归一化各字段 */
function parseResponse(json: unknown, maxResults: number): SearxngResponse {
  const root = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;

  const results: SearchItem[] = [];
  const seen = new Set<string>();
  const rawResults = Array.isArray(root.results) ? root.results : [];
  for (const raw of rawResults) {
    const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title : "";
    const url = typeof item.url === "string" ? item.url : "";
    const content =
      typeof item.content === "string" ? item.content : typeof item.snippet === "string" ? item.snippet : "";
    const engine = typeof item.engine === "string" ? item.engine : "";
    if (!title && !url && !content) continue;
    if (url) {
      const norm = normalizeUrl(url);
      if (seen.has(norm)) continue; // 保留首次出现
      seen.add(norm);
    }
    results.push({
      title,
      url,
      content,
      engine,
      publishedDate: typeof item.publishedDate === "string" ? item.publishedDate : undefined,
      score: typeof item.score === "number" ? item.score : undefined,
    });
    if (results.length >= maxResults) break;
  }

  // infoboxes[0]：content 可能是字符串或数组
  const infoboxes = Array.isArray(root.infoboxes) ? root.infoboxes : [];
  let infobox: SearxngInfobox | null = null;
  if (infoboxes.length > 0) {
    const ib = (infoboxes[0] && typeof infoboxes[0] === "object" ? infoboxes[0] : {}) as Record<string, unknown>;
    let content = "";
    if (typeof ib.content === "string") content = ib.content;
    else if (Array.isArray(ib.content)) {
      content = ib.content.filter((x): x is string => typeof x === "string").join(" / ");
    }
    const box = (ib.infobox && typeof ib.infobox === "object" ? ib.infobox : {}) as Record<string, unknown>;
    const title = typeof box.title === "string" ? box.title : typeof ib.title === "string" ? (ib.title as string) : "";
    if (title || content) infobox = { title, content };
  }

  // unresponsive_engines：元素可能是字符串或 {engine, error}
  const unresponsive = (Array.isArray(root.unresponsive_engines) ? root.unresponsive_engines : []).map((e) => {
    if (typeof e === "string") return e;
    if (e && typeof e === "object") {
      const o = e as Record<string, unknown>;
      const name = typeof o.engine === "string" ? o.engine : "unknown";
      const err = typeof o.error === "string" ? o.error : "error";
      return `${name}(${err})`;
    }
    return String(e);
  });

  return {
    results,
    answers: strArray(root.answers),
    corrections: strArray(root.corrections),
    suggestions: strArray(root.suggestions),
    infobox,
    unresponsive,
  };
}

/**
 * 请求 SearXNG 原始 JSON。
 * 网络错误 / HTTP 429 / 5xx：延迟 1.5s 重试一次；调用方 signal 已 abort 则不重试。
 */
async function fetchSearxngRaw(cfg: SearchConfig, p: SearchParams, callerSignal?: AbortSignal): Promise<unknown> {
  if (!cfg.token) {
    throw new Error("未设置 SEARXNG_TOKEN（可 export SEARXNG_TOKEN=... 或用 /web-search config token <token>）");
  }
  const params = new URLSearchParams({
    q: p.query,
    format: "json",
  });
  if (p.engines) params.set("engines", p.engines);
  if (p.language) params.set("language", p.language);
  if (p.pageno && p.pageno > 1) params.set("pageno", String(p.pageno));
  if (p.timeRange) params.set("time_range", p.timeRange);

  const fetchImpl = await createFetch();
  const url = `${(cfg.url ?? DEFAULT_URL).replace(/\/+$/, "")}?${params.toString()}`;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { "X-Search-Token": cfg.token, Accept: "application/json" },
        signal: combineSignals(REQUEST_TIMEOUT_MS, callerSignal),
      });
    } catch (err) {
      // 网络错误（fetch failed / aborted due to timeout 等）
      if (callerSignal?.aborted) throw new CancelledError();
      if (attempt < 1) {
        await sleepAbortable(RETRY_DELAY_MS, callerSignal);
        if (callerSignal?.aborted) throw new CancelledError();
        continue;
      }
      if (isTimeoutError(err)) {
        throw new Error("请求超时（20s）。默认引擎组较慢，建议指定更快引擎如 engines=bing");
      }
      throw new Error(`网络错误：${err instanceof Error ? err.message : String(err)}`);
    }

    if (res.status === 429 || res.status >= 500) {
      await cancelResponseBody(res);
      if (callerSignal?.aborted) throw new CancelledError();
      if (attempt < 1) {
        await sleepAbortable(RETRY_DELAY_MS, callerSignal);
        if (callerSignal?.aborted) throw new CancelledError();
        continue;
      }
      throw new Error(
        res.status === 429
          ? "服务器限流（HTTP 429），请稍后再试"
          : `SearXNG 服务器错误（HTTP ${res.status}），请稍后再试`,
      );
    }
    if (res.status === 401) {
      throw new Error("鉴权失败：X-Search-Token 缺失或错误（HTTP 401）。请设置环境变量 SEARXNG_TOKEN 或用 /web-search config token <token>");
    }
    if (res.status === 403) {
      throw new Error("Token 被服务器拒绝（HTTP 403，Nginx 层）。请检查 SEARXNG_TOKEN 是否正确");
    }
    if (!res.ok) throw new Error(`SearXNG 请求失败 HTTP ${res.status}`);
    return await res.json();
  }
}

// ============================================================================
// 内存缓存（TTL 5 分钟，上限 100 条，只缓存成功响应）
// ============================================================================
const searchCache = new Map<string, { at: number; payload: SearxngResponse }>();

function cacheKey(p: Pick<SearchParams, "query" | "engines" | "language" | "timeRange" | "pageno">): string {
  return [p.query.toLowerCase(), p.engines || "", p.language || "", p.timeRange || "", p.pageno || 1].join("\u0000");
}

function cacheGet(key: string): SearxngResponse | undefined {
  const hit = searchCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    searchCache.delete(key);
    return undefined;
  }
  return hit.payload;
}

function cacheSet(key: string, payload: SearxngResponse): void {
  if (searchCache.size >= CACHE_MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [k, v] of searchCache) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) searchCache.delete(oldestKey);
  }
  searchCache.set(key, { at: Date.now(), payload });
}

/** 搜索入口：先查缓存，未命中则请求并缓存（仅成功响应） */
async function runSearch(p: SearchParams, callerSignal?: AbortSignal): Promise<SearxngResponse> {
  if (callerSignal?.aborted) throw new CancelledError();
  const key = cacheKey(p);
  const cached = cacheGet(key);
  if (cached) return cached;
  const cfg = loadConfig();
  const json = await fetchSearxngRaw(cfg, p, callerSignal);
  const parsed = parseResponse(json, CACHE_MAX_RESULTS);
  cacheSet(key, parsed);
  return parsed;
}

// ============================================================================
// web_search 输出格式化
// ============================================================================
function formatSearchResponse(resp: SearxngResponse, maxResults: number): string {
  const parts: string[] = [];

  if (resp.answers.length > 0) parts.push(`[answers] ${resp.answers.join(" | ")}`);
  if (resp.corrections.length > 0) parts.push(`[corrections] ${resp.corrections.join(" | ")}`);

  const results = resp.results.slice(0, maxResults);
  if (results.length > 0) {
    parts.push(
      results
        .map((r, i) => {
          const lines = [`${i + 1}. ${r.title || "(无标题)"}`];
          if (r.url) lines.push(`   URL: ${r.url}`);
          if (r.content) lines.push(`   ${r.content.slice(0, 300)}`);
          if (r.engine) lines.push(`   engine: ${r.engine}`);
          if (r.publishedDate) lines.push(`   date: ${r.publishedDate}`);
          if (typeof r.score === "number") lines.push(`   score: ${r.score}`);
          return lines.join("\n");
        })
        .join("\n\n"),
    );
  }

  if (resp.infobox) {
    const prefix = resp.infobox.title ? `${resp.infobox.title}: ` : "";
    parts.push(`[infobox] ${prefix}${resp.infobox.content.slice(0, 200)}`);
  }
  if (resp.suggestions.length > 0) parts.push(`[suggestions] ${resp.suggestions.join(", ")}`);
  if (resp.unresponsive.length > 0) parts.push(`[warn] 无响应引擎: ${resp.unresponsive.join(", ")}`);

  if (parts.length === 0) return "（无搜索结果，可尝试换关键词或指定 engines）";
  return parts.join("\n\n");
}

// ============================================================================
// web_fetch：抓取静态网页 → 正文纯文本
// ============================================================================
function decodeHtmlEntities(s: string): string {
  const toChar = (code: number, fallback: string): string => {
    try {
      return String.fromCodePoint(code);
    } catch {
      return fallback;
    }
  };
  return s
    .replace(/&#x([0-9a-fA-F]+);?/g, (m, h: string) => toChar(parseInt(h, 16), m))
    .replace(/&#(\d+);?/g, (m, d: string) => toChar(parseInt(d, 10), m))
    .replace(/&nbsp;/gi, "\u00A0")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** HTML → 纯文本：main/article/body 提取 + 删块 + 删标签 + 解码实体 + 合并空白 */
function htmlToText(raw: string): string {
  let html = raw;
  // 优先 <main> 或 <article>，其次 <body>，都没有则全文
  const scope =
    html.match(/<main[^>]*>([\s\S]*?)<\/main\s*>/i) ||
    html.match(/<article[^>]*>([\s\S]*?)<\/article\s*>/i);
  if (scope) {
    html = scope[1];
  } else {
    const body = html.match(/<body[^>]*>([\s\S]*?)<\/body\s*>/i);
    if (body) html = body[1];
  }
  // 删除 script/style/noscript/svg/template/head 块（含内容）
  html = html.replace(/<(script|style|noscript|svg|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  // 删除剩余所有标签
  html = html.replace(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(html);
  // 合并连续空白行
  return decoded
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 流式读取响应体，上限 FETCH_MAX_BODY_BYTES（超出截断） */
async function readBodyLimited(res: Response): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const decoder = new TextDecoder("utf-8");
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > FETCH_MAX_BODY_BYTES) {
        const room = FETCH_MAX_BODY_BYTES - (total - value.byteLength);
        if (room > 0) chunks.push(value.subarray(0, room));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    if (truncated) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
    reader.releaseLock();
  }
  let text = "";
  for (let i = 0; i < chunks.length; i++) {
    text += decoder.decode(chunks[i], { stream: i < chunks.length - 1 });
  }
  text += decoder.decode();
  return text;
}

async function fetchPage(url: string, maxChars: number): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url 必须是 http/https";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "url 必须是 http/https";
  }

  const fetchImpl = await createFetch();
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        "User-Agent": "pi-web-fetch/1.0 (personal agent)",
        Accept: "text/html,text/plain,text/markdown;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (isTimeoutError(err)) return "web_fetch 失败：请求超时（20s）";
    return `web_fetch 失败：${err instanceof Error ? err.message : String(err)}`;
  }

  if (res.status >= 400) {
    await cancelResponseBody(res);
    const base = `web_fetch 失败 HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      return `${base}：站点可能屏蔽了程序化访问，改用 agent_browser`;
    }
    return base;
  }

  const raw = await readBodyLimited(res);
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  let text: string;
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    text = htmlToText(raw);
  } else if (contentType === "text/plain" || contentType === "text/markdown" || contentType === "application/json") {
    text = raw;
  } else {
    return `不支持的 Content-Type: ${contentType || "unknown"}（可用 agent_browser 打开）`;
  }

  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}\n[已截断，原文 ${text.length} 字符]`;
  }
  return text;
}

// ============================================================================
// 扩展主体
// ============================================================================
export default function (pi: ExtensionAPI) {
  // ---------- 工具：web_search（模型可调用） ----------
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "通过私有 SearXNG 实例搜索互联网，返回标题/链接/摘要/发布日期/引擎。" +
      "engines 逗号分隔可选：google(全面,~1-2s)、bing(快,中文可用)、yandex、360search(中文)、github(代码仓库)、stackoverflow(问答)、mdn(Web文档)。" +
      "不填用服务器默认组(google cse+bing+yandex+360search,~1s)。追求单引擎速度时指定 engines。",
    promptSnippet: "Search the internet via a private SearXNG instance; returns title/link/snippet/engine",
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词" }),
      engines: Type.Optional(Type.String({
        description:
          "逗号分隔的引擎，可选：google(全面,~1-2s)、bing(快,中文可用)、yandex、360search(中文)、github(代码仓库)、stackoverflow(问答)、mdn(Web文档)。" +
          "不填用服务器默认组(google cse+bing+yandex+360search,~1s)",
      })),
      language: Type.Optional(Type.String({ description: "语言，如 zh-CN、en" })),
      timeRange: Type.Optional(Type.Union([
        Type.Literal("day"),
        Type.Literal("week"),
        Type.Literal("month"),
        Type.Literal("year"),
      ], { description: "时间范围（可选）" })),
      pageno: Type.Optional(Type.Number({ description: "页码，默认 1" })),
      maxResults: Type.Optional(Type.Number({ description: "返回条数上限（默认 8，最大 20）" })),
    }),
    async execute(_toolCallId, params: {
      query: string;
      engines?: string;
      language?: string;
      timeRange?: "day" | "week" | "month" | "year";
      pageno?: number;
      maxResults?: number;
    }, signal, _onUpdate, _ctx) {
      try {
        if (signal?.aborted) return { content: [{ type: "text" as const, text: "已取消" }], details: {} };
        const maxResults = Math.min(Math.max(params.maxResults ?? 8, 1), 20);
        const resp = await runSearch(
          {
            query: params.query,
            engines: params.engines,
            language: params.language,
            pageno: params.pageno,
            timeRange: params.timeRange,
            maxResults,
          },
          signal,
        );
        const count = Math.min(resp.results.length, maxResults);
        return {
          content: [{ type: "text" as const, text: formatSearchResponse(resp, maxResults) }],
          details: { count },
        };
      } catch (error) {
        if (error instanceof CancelledError) {
          return { content: [{ type: "text" as const, text: "已取消" }], details: {} };
        }
        return {
          content: [{
            type: "text" as const,
            text: `web_search 出错：${error instanceof Error ? error.message : String(error)}`,
          }],
          details: { error: true },
        };
      }
    },
  });

  // ---------- 工具：web_fetch（静态页面全文） ----------
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "抓取网页并返回正文纯文本（默认上限 20000 字符）。用于 web_search 后阅读静态页面全文。" +
      "不支持 JS 渲染页面（那些用 agent_browser）。",
    promptSnippet:
      "Fetch a web page as plain text (default cap 20000 chars); static pages only, use agent_browser for JS-rendered pages",
    parameters: Type.Object({
      url: Type.String({ description: "要抓取的 URL（必须是 http/https）" }),
      maxChars: Type.Optional(Type.Number({ description: `输出字符上限（默认 ${MAX_FETCH_CHARS_DEFAULT}，最大 ${MAX_FETCH_CHARS_LIMIT}）` })),
    }),
    async execute(_toolCallId, params: { url: string; maxChars?: number }, signal, _onUpdate, _ctx) {
      try {
        if (signal?.aborted) return { content: [{ type: "text" as const, text: "已取消" }], details: {} };
        const maxChars = Math.min(Math.max(Math.floor(params.maxChars ?? MAX_FETCH_CHARS_DEFAULT), 1), MAX_FETCH_CHARS_LIMIT);
        const text = await fetchPage(params.url, maxChars);
        return {
          content: [{ type: "text" as const, text }],
          details: { chars: text.length },
        };
      } catch (error) {
        if (error instanceof CancelledError) {
          return { content: [{ type: "text" as const, text: "已取消" }], details: {} };
        }
        return {
          content: [{
            type: "text" as const,
            text: `web_fetch 出错：${error instanceof Error ? error.message : String(error)}`,
          }],
          details: { error: true },
        };
      }
    },
  });

  // ---------- 命令：/web-search（手动测试 + 配置） ----------
  pi.registerCommand("web-search", {
    description: "SearXNG 搜索：/web-search <关键词>；/web-search config url|token <值>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const verb = parts[0];

      if (!verb) {
        const cfg = loadConfig();
        ctx.ui.notify(
          `SearXNG 配置：\n  url:   ${cfg.url}\n  token: ${cfg.token ? "已设置(隐藏)" : "未设置"}\n` +
            `用法：/web-search <关键词> 搜索；/web-search config url <地址> 或 config token <token> 持久化`,
          "info",
        );
        return;
      }

      if (verb === "config") {
        const key = parts[1];
        const value = parts.slice(2).join(" ");
        if (key === "url" && value) {
          saveConfig({ url: value });
          ctx.ui.notify(`SEARXNG_URL 已保存：${value}`, "info");
          return;
        }
        if (key === "token" && value) {
          saveConfig({ token: value });
          ctx.ui.notify("SEARXNG_TOKEN 已保存（本地 searxng-config.json）。", "info");
          return;
        }
        ctx.ui.notify("用法：/web-search config url <地址> | config token <token>", "info");
        return;
      }

      // 直接搜索
      try {
        const resp = await runSearch({ query: args.trim(), maxResults: 8 });
        ctx.ui.notify(`SearXNG 结果：\n${formatSearchResponse(resp, 8).slice(0, 1500)}`, "info");
      } catch (error) {
        ctx.ui.notify(`搜索失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
