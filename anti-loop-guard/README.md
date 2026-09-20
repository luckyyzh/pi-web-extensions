# anti-loop-guard

重复工具调用拦截 + 短结果显式化，从 agent 侧打掉「重复调用」和「失败不显式」两个根因。

## 背景

长上下文下小模型（如 Qwen3.8-27B-FP8）会反复用**完全相同的参数**调用同一个工具（例如反复
`web_fetch` 同一个 URL），而该工具每次只返回 ~76 token 的无效内容；模型不认为这是「失败」，
于是无限循环。本扩展针对这两个根因：

## 行为

- **行为 A：重复调用拦截**（`pi.on("tool_call")`）
  - key = `工具名:canonicalJson(参数)`，`canonicalJson` 为自写的递归按 key 排序稳定序列化（无依赖）；
  - 计数按会话隔离，`session_start` 时清空全部状态；
  - 「重复」只看两种情形：
    1. **紧邻重复**：上一个工具调用与本次完全同参（连续 streak）；
    2. **上次结果无效后的同参数重试**：该 key 上次结果被判定为无效（`isError === true`，
       或白名单工具文本过短）后的再次同参尝试。
  - 紧邻第 `REPEAT_BLOCK_AT`(=2) 次 `{ block: true, reason }`；紧邻第 `REPEAT_TERMINATE_AT`(=3) 次
    `{ block: true, terminate: true, reason }`；
  - 因此 `read 文件 → edit → 再 read 同一文件`、`git status` 跑两次、`npm test` 重跑等
    **合法重试不会被拦**（既非同参紧邻，上次结果也不是无效）；
  - `reason` 包含：工具名与参数摘要、已调用次数、判定依据、上次结果的前
    `LAST_RESULT_EXCERPT_CHARS`(=300) 个字符（若有）、以及明确指令「不要再用相同参数重复该调用；
    换工具/换参数/换 URL，或停止并向用户报告卡点」。
- **行为 B：短结果显式化**（`pi.on("tool_result")`）
  - 仅白名单 `SHORT_RESULT_TOOLS`(= `["web_fetch"]`)；其他工具（read/grep/ls 等）的短结果合法，**绝不改写**；
  - **判定不以「短」为准**，只看是否命中「无效页面」：
    - 提取后正文为空（trim 后为空字符串），或只剩未剥离的 HTML 空壳（`<!doctype|html|head|body`）；
    - 或不超 `MAX_INVALID_PAGE_CHARS`(=1000) 字符且命中 `INVALID_PAGE_PATTERNS`：
      `enable javascript` / `just a moment` / `checking your browser` / `verify you are human` /
      `attention required` / `access denied` / `forbidden` / `captcha` / `403|429|502|503` /
      `too many requests` / `rate limit` / `service unavailable` / `bad gateway` / `timeout` /
      `connection reset`；
  - 因此**合法的短响应不会被标错**（小 JSON、短文本接口、预料中的 404 页）；
    而长度只作为**上限**，避免长正文里提到「403」被误判；
  - 命中时返回 `{ content: [原文本(保留，过长截断) + 明确说明], isError: true }`；
  - 说明内容：命中「无效页面」特征（需 JS 渲染 / 被反爬拦截 / 403-429-5xx / 内容提取为空），
    **不要用相同参数重试**，改用其他工具（如 `web_search` / `agent_browser`）或换 URL；
  - content 数组中的非文本项（图片等）原样保留；
  - 无论是否命中，都会记录摘要与无效判定（对所有工具），供下次 block 理由引用。

## 可调参数

集中在 `extensions/anti-loop-guard.ts` 文件头：`DISABLED`、`DEBUG`、`REPEAT_BLOCK_AT`、
`REPEAT_TERMINATE_AT`、`SHORT_RESULT_TOOLS`、`MAX_INVALID_PAGE_CHARS`、
`INVALID_PAGE_PATTERNS`、`LAST_RESULT_EXCERPT_CHARS`
（另有内部上限 `REWRITE_ORIGINAL_CAP`、`INPUT_SUMMARY_CAP`）。

调参建议：`DEBUG = true` 后 stderr 会打印「短但无无效特征，未改写」和「无效页面」两类日志，
据此判断 `INVALID_PAGE_PATTERNS` 是否需要补充。

## 自测

加载方式与 mock 约定与 `pi-long-command-guard/tests` 一致（typescript 从 pi-web 工作区解析，
transpileModule 编译成 CJS 后在 vm 沙箱执行；无第三方依赖；含 strict 类型检查用例）。

在本包目录下运行（需要 Node 可用且 pi-web 工作区存在 typescript 与 @types/node）：

```bat
cd C:\Users\10740\.pi\agent\pi-web-extensions\anti-loop-guard
node --test tests\anti-loop-guard.test.cjs
```

可选：`set PI_BG_TEST_WORKSPACE=<其他工作区>` 覆盖 typescript/@types 解析位置。

## 语义说明（假设）

- `tool_call` 返回 `{ block: true, reason }` 阻止执行，`reason` 成为注入的 error tool result 文本；
  `terminate` 只对已 block 的调用生效，且当批所有 finalized 结果都终止时 agent 才提前停。
- `tool_result` 返回 `{ content, isError }` 为字段级覆盖（content 整体替换），省略字段保持原值。
- 被 block 的调用同样计入尝试次数（避免「block 了还重试」绕过计数）。
- `terminate` 以**紧邻重复**的连续次数为准；「上次结果无效后重试」只 block、不 terminate，
  以免一次无关紧要的重试就终止整个回合。
