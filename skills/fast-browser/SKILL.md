---
name: fast-browser
description: agent_browser 高性能执行规范。当浏览器任务涉及多步操作、多项数据读取、大页面浏览或需要复用登录态时使用，用批处理（job/batch/script）减少模型往返，用范围快照减少 token。
---

# fast-browser

核心：任务耗时的大头是**模型往返**和**塞进上下文的页面内容**，浏览器本身很快。合并一次调用 = 省一次往返；快照越早裁小越省（之后每次往返都重复 prefill）。

## 路径选择

| 场景 | 做法 |
|---|---|
| 读 N≥2 个已知数据项 | 一次 `batch`（stdin 传 JSON token 数组） |
| 3+ 步流程（打开/填表/点击/确认） | 一次 `job`（验证内嵌末尾） |
| 公开页 + 循环/分支/多页聚合，无登录 | 一次 `script` |
| 需要登录态 | 先建认证会话（见下），再 job/batch |
| 只读文档/正文 | `read <url>` |
| 回归检查 | `qa` |

## 读取

- 已知 selector 直接 `get text/count/html/value/attr`，别先 snapshot。
- 要看结构先裁剪：`snapshot -i --search <词>` / `--filter role=button`（wrapper 独有，裸 CLI 忽略）、`--depth` / `--selector` / `--compact`；最后才全量 `-i`。
- 小变化后用 `get` 定向读；`snapshot --diff` 只是变化摘要，不省 token。
- 多项读取合并一次 batch（JSON 只走 stdin，塞 argv 报 Unknown command）。

## job

- 验证放末尾：`assertText` / `assertUrl`（精确或 glob），别另起调用"确认一下"。
- `open` 用 `loadState`，不单独 wait；点击后要新 @ref 就拆 job 重拍快照，只用稳定 selector/assert 可继续。
- 示例：open(loadState) → fill → fill → click → assertUrl → assertText，一次调用。

## script（仅公开页）

- 每次调用 = 隔离会话（有冷启动），挂不了真实 Chrome、环境被清空（退回缓存浏览器检测）。
- 适合循环/分支/聚合；高频重复跑的话热会话 + batch 更快。

```js
const out = [];
for (const u of urls) {
  const o = await browser({ args: ["open", u] });
  if (!o.ok) throw new Error(o.error);
  const w = await browser({ args: ["wait", "--load", "domcontentloaded"] });
  if (!w.ok) throw new Error(w.error);
  const p = await browser({ args: ["eval", "--stdin"],
    stdin: "JSON.stringify({ title: document.title, items: document.querySelectorAll('.item').length })" });
  if (!p.ok) throw new Error(p.error);
  out.push(p.data.result);
}
emit(out);
```

## 登录态（最大提速：免重登录/2FA/SSO）

- 复用真实 Chrome：`--profile Default`（Windows 需先关 Chrome）
- 持久 profile（长期推荐）：`--profile <目录>`，登录一次无限复用
- 导入已登录态：Chrome 加 `--remote-debugging-port=9222` 启动 → `--auto-connect state save ./auth.json` → 以后 `--state ./auth.json`（文件别提交 git）
- 自动持久化：`--session <name> --restore`
- 以上 launch 标志都配 `sessionMode: "fresh"` 发起

## 会话

- 默认 auto 复用（daemon 空闲 1h），别随手 close；只有切 launch 标志时用 `fresh`。
- 独立站点任务用 `--session <name>` 隔离。

## 排错

- **"Chrome not found"**：上游只检测 `~/.agent-browser/browsers` 缓存 / 系统标准 Chrome 路径（Edge 不在列），script 隔离会话不能指定浏览器 → 装 Chrome（官方源不通走镜像/手动）。全新浏览器首跑可能超 1 分钟（杀软扫描），超时给足。
- **裸 CLI 从 PowerShell "假死"**：daemon 继承 stdout 管道句柄，`| Out-String` / ReadToEnd 等不到 EOF（症状：新 session 首命令挂、后续正常）→ 重定向到文件再读，或任务结束 close 自己的 session。
- **stale-ref**：页面变化后 @ref 作废，按 `details.nextActions` 重拍快照或换稳定 selector。

## 反模式

- 一步一调（open→snapshot→click→…）→ 合并 job/batch
- 全量 snapshot 找 selector 就能拿的东西
- 动作成功后追加"保险"截图/确认
- 用 script 跑需要登录态的任务
- 页面小变化就重拍全量快照
