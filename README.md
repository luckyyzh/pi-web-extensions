# Pi Web Extensions

三个独立的 pi 扩展包，用于 pi + pi-web 环境。每个都是独立的 pi 包（`pi` 清单 + `extensions/`），可单独安装/启停/卸载。

> **pi-web-vitals 已移除**：其功能（缓存命中率、人设注入）已集成到 pi-web 原生 —— 缓存命中率显示在右上角 token 栏，人设通过顶部「人设」标签编辑，由 pi-web 内置的 persona-injector 扩展注入。MCP 管理已由 pi-web 插件栏内置面板替代，无需独立插件。

## 包含

| 包 | 功能 | 配置 |
|----|------|------|
| **searxng-search** | 通过自建 SearXNG 端点提供 `web_search` 工具（X-Search-Token 鉴权） | `/web-search config url <地址>`、`/web-search config token <token>`；或环境变量 `SEARXNG_URL` / `SEARXNG_TOKEN` |
| **describe-image** | 按需识图：给非视觉模型(如 DeepSeek)加识图能力，主模型调 `describe_image` 工具 + 外部视觉模型(qwen-vl 等) | `/describe-image config baseUrl <地址>`、`/describe-image config model <模型>`、`/describe-image config apiKey <key>`；或环境变量 `VISION_BASE_URL` / `VISION_MODEL` / `VISION_API_KEY` |
| **ssh** | SSH 远程执行：把 read/write/edit/bash 转发到远程机器执行；webUI 场景配合 pi-web 影子目录，会话按远程目录隔离 | `/ssh user@host` 或 `/ssh user@host:/path` 启用、`/ssh off` 退出；webUI 模式读写 `~/.pi/agent/ssh-config.json`（需 SSH 密钥免密） |

> 密钥一律通过环境变量或 `~/.pi/agent/` 下各自的配置文件提供，扩展源码不包含任何密钥。

## 安装（从本仓库）

克隆后逐个本地安装（保持三个包独立管理）：

```bash
git clone https://github.com/luckyyzh/pi-web-extensions.git
cd pi-web-extensions
pi install ./searxng-search
pi install ./describe-image
pi install ./ssh
```

在 pi-web Plugins 面板中可看到三个独立包，可单独启用/禁用/卸载。
安装后 `/reload` 或新开会话生效。

## 目录结构

```
searxng-search/
  package.json
  extensions/searxng-search.ts
describe-image/
  package.json
  extensions/describe-image.ts
ssh/
  package.json
  extensions/ssh.ts
```
