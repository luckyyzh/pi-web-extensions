/**
 * anti-loop-guard：从 agent 侧打掉「重复调用」与「失败不显式」两个根因。
 *
 * 背景：长上下文下模型（如 Qwen3.8-27B-FP8）会反复用完全相同的参数调用同一个
 * 工具（例如反复 web_fetch 同一个 URL），每次只返回极少 token 的无效内容，
 * 而模型不认为这是「失败」，于是无限循环。
 *   行为 A：重复调用拦截 —— 判定「重复」只看两种情形：
 *     (1) 紧邻重复：上一个工具调用与本次完全同参（连续 streak）；
 *     (2) 上次同类结果已被判定无效（isError，或白名单工具文本过短）后的再次同参尝试。
 *     紧邻第 2 次 block，紧邻第 3 次 block + terminate。
 *     read 文件 → edit → 再 read 同一个文件、git status 跑两次这类合法重试不受影响。
 *   行为 B：短结果显式化 —— 白名单工具（web_fetch）的结果命中「无效页面」特征时才改写为
 *     isError=true，并在文本中明确「不要用相同参数重试」：正文提取为空或只剩 HTML 空壳，
 *     或页面不超长且含 JS 必需 / Cloudflare 拦截 / 403-429-5xx / 超时等字样。
 *     判定不以「短」为准：合法的短响应（小 JSON、短文本接口、预料中的 404 页）一律不动；
 *     长度只作为上限，避免长正文里出现「403」字样被误判。read/grep/ls 等工具绝不改写。
 *
 * 只用 @earendil-works/pi-coding-agent 的 ExtensionAPI 类型 + node 内置能力，
 * 不引第三方依赖；canonicalJson 为自写的按 key 排序稳定序列化。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ================= 可调参数（集中于此，便于调参） =================
const DISABLED = false;
const DEBUG = false;
/** 第 N 次相同调用（含本次）→ block */
const REPEAT_BLOCK_AT = 2;
/** 第 N 次相同调用（含本次）→ block + terminate */
const REPEAT_TERMINATE_AT = 3;
/** 只有白名单工具的短结果会被改写（其他工具短结果合法） */
const SHORT_RESULT_TOOLS: readonly string[] = ["web_fetch"];
/**
 * 「无效页面」特征匹配的文本长度上限。正文一般远大于此；
 * 超长文本里出现「403」之类字样只当普通内容，不当作抓取失败。
 */
const MAX_INVALID_PAGE_CHARS = 1000;
/**
 * 「页面无效」特征：命中则说明这次抓取实质失败，而不是页面本身很短。
 * 大小写不敏感；仅对不超过 MAX_INVALID_PAGE_CHARS 的文本生效。
 */
const INVALID_PAGE_PATTERNS: readonly RegExp[] = [
  /enable javascript|javascript is (disabled|required)|requires javascript/i,
  /just a moment|checking your browser|verify(ing)? you are human|are you a robot/i,
  /attention required|access denied|forbidden|captcha|unusual traffic/i,
  /\b(403|429|502|503)\b|too many requests|service unavailable|bad gateway|rate limit/i,
  /connection (reset|timed out)|request timed out|socket hang up|timed out/i,
];
/** block 理由里引用上次结果时，最多取前 N 个字符 */
const LAST_RESULT_EXCERPT_CHARS = 300;
/** 改写时保留的原文本截断上限（避免长正文被整段重写进上下文） */
const REWRITE_ORIGINAL_CAP = 500;
/** reason 中参数摘要长度上限，避免超长参数撑爆上下文 */
const INPUT_SUMMARY_CAP = 200;

/** 递归按 key 排序的稳定序列化：同一份数据永远得到同一个字符串（自写，无依赖）。 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return JSON.stringify(value);
  if (kind === "number") return Number.isFinite(value) ? String(value) : "null";
  if (kind !== "object") return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  return `{${entries.join(",")}}`;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…（已截断）`;
}

/** 提取后什么都没有，或只剩未剥离的 HTML 空壳（与长度无关）。 */
function looksEmptyPage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  return /^<(!doctype|html|head|body)\b/i.test(trimmed);
}

/** 结果是否命中「页面无效」特征：提取为空/HTML 空壳，或不超长且命中拦截特征。 */
function looksInvalidPage(text: string): boolean {
  if (looksEmptyPage(text)) return true;
  if (text.length > MAX_INVALID_PAGE_CHARS) return false;
  return INVALID_PAGE_PATTERNS.some((pattern) => pattern.test(text));
}

export default function (pi: ExtensionAPI): void {
  if (DISABLED) return;

  // 会话级状态，key = `工具名:canonicalJson(参数)`，按会话隔离
  const attempts = new Map<string, number>(); // 同参数累计尝试次数（含被 block 的）
  const unhelpful = new Map<string, boolean>(); // key → 上次结果是否已判定无效
  const lastResultExcerpts = new Map<string, string>(); // key → 该调用最近一次结果的摘要
  let lastKey: string | null = null; // 上一个工具调用，用于识别紧邻重复
  let streak = 0; // 紧邻同参调用连续次数

  pi.on("session_start", () => {
    attempts.clear();
    unhelpful.clear();
    lastResultExcerpts.clear();
    lastKey = null;
    streak = 0;
    if (DEBUG) process.stderr.write("[anti-loop-guard] session_start：计数表与结果摘要表已清空\n");
  });

  // ===== 行为 A：重复调用拦截 =====
  pi.on("tool_call", (event) => {
    const key = `${event.toolName}:${canonicalJson(event.input)}`;
    streak = key === lastKey ? streak + 1 : 1;
    lastKey = key;
    const count = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, count);

    // 紧邻重复命中阈值，或「上次结果无效后的再次同参尝试」→ 拦截
    const adjacentRepeat = streak >= REPEAT_BLOCK_AT;
    const retryAfterUnhelpful = unhelpful.get(key) === true && count >= REPEAT_BLOCK_AT;
    if (!adjacentRepeat && !retryAfterUnhelpful) return; // 首次/非同参：正常放行

    // 组装理由：工具名+参数摘要、已调用次数、上次结果摘要（若有）、明确指令
    const lines: string[] = [
      `重复调用已拦截：${event.toolName} 此前已用相同参数调用 ${count - 1} 次（本次为第 ${count} 次），本次被阻止执行。`,
      adjacentRepeat ? "判定依据：上一个工具调用与本次完全同参。" : "判定依据：上次同类调用返回的结果已判定为无效。",
      `参数摘要：${truncate(canonicalJson(event.input), INPUT_SUMMARY_CAP)}`,
    ];
    const excerpt = lastResultExcerpts.get(key);
    if (excerpt) lines.push(`上次结果（前 ${excerpt.length} 字符）：${excerpt}`);
    lines.push("不要再用相同参数重复该调用；换工具/换参数/换 URL，或停止并向用户报告卡点。");
    const reason = lines.join("\n");
    if (DEBUG) process.stderr.write(`[anti-loop-guard] block ${event.toolName} count=${count} streak=${streak} key=${key}\n`);
    if (streak >= REPEAT_TERMINATE_AT) return { block: true, terminate: true, reason };
    return { block: true, reason };
  });

  // ===== 行为 B：短结果显式化 =====
  pi.on("tool_result", (event) => {
    const text = event.content
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("");
    const key = `${event.toolName}:${canonicalJson(event.input)}`;
    const isWhitelisted = SHORT_RESULT_TOOLS.includes(event.toolName);
    // 判定不以长度为准：合法的短响应不动，只有真正命中「无效页面」特征才改写。
    const invalidPage = isWhitelisted && looksInvalidPage(text);

    // 无效判定与摘要对所有工具都记录：显式错误的结果同样不该用相同参数重试。
    unhelpful.set(key, event.isError === true || invalidPage);
    lastResultExcerpts.set(key, text.slice(0, LAST_RESULT_EXCERPT_CHARS));
    if (!invalidPage) {
      if (isWhitelisted && DEBUG) process.stderr.write(`[anti-loop-guard] 未命中无效特征，未改写 ${event.toolName} chars=${text.length}\n`);
      return;
    }
    if (DEBUG) process.stderr.write(`[anti-loop-guard] 无效页面 ${event.toolName} chars=${text.length}\n`);

    // 改写内容 = 原文本（保留，过长截断到上限）+ 明确说明
    const note =
      `[anti-loop-guard] 该结果（${text.length} 字符）命中「无效页面」特征：` +
      "页面可能需要 JS 渲染、被反爬拦截（Cloudflare/CAPTCHA）、返回 403/429/5xx，或内容提取为空。\n" +
      "不要用相同参数重试；改用其他工具（如 web_search / agent_browser）或换 URL。";
    const rewritten = `${truncate(text, REWRITE_ORIGINAL_CAP)}\n\n${note}`;

    // 文本片段合并为一条改写文本（放在原首个文本片段的位置）；
    // 非文本项（图片等）原样保留在原位置，其余文本片段已被合并，跳过以免重复。
    const content: typeof event.content = [];
    let firstTextPlaced = false;
    for (const item of event.content) {
      if (item.type === "text") {
        if (!firstTextPlaced) {
          content.push({ type: "text", text: rewritten });
          firstTextPlaced = true;
        }
      } else {
        content.push(item);
      }
    }
    if (!firstTextPlaced) content.push({ type: "text", text: rewritten });
    return { content, isError: true };
  });
}
