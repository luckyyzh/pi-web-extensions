# Pi Web Extensions

三个独立的 pi 扩展包，用于 pi + pi-web 环境。每个都是独立的 pi 包（`pi` 清单 + `extensions/`），可单独安装/启停/卸载。

## 包含

| 包 | 功能 | 配置 |
|----|------|------|
| **pi-web-vitals** | 聊天框底部信息栏显示缓存命中率(缓存读/(输入+缓存读))、MCP 服务器状态；/persona 全局人设注入 | `/persona set <人设>`、`/mcp-ui enable|disable <server>` |
| **searxng-search** | 通过自建 SearXNG 端点提供 `web_search` 工具（X-Search-Token 鉴权） | `/web-search config url <地址>`、`/web-search config token <token>`；或环境变量 `SEARXNG_URL` / `SEARXNG_TOKEN` |
| **describe-image** | 按需识图：给非视觉模型(如 DeepSeek)加识图能力，主模型调 `describe_image` 工具 + 外部视觉模型(qwen-vl 等) | `/describe-image config baseUrl <地址>`、`/describe-image config model <模型>`、`/describe-image config apiKey <key>`；或环境变量 `VISION_BASE_URL` / `VISION_MODEL` / `VISION_API_KEY` |

> 密钥一律通过环境变量或 `~/.pi/agent/` 下各自的配置文件提供，扩展源码不包含任何密钥。

## 安装（从本仓库）

克隆后逐个本地安装（保持三个包独立管理）：

```bash
git clone https://github.com/luckyyzh/pi-web-extensions.git
cd pi-web-extensions
pi install ./pi-web-vitals
pi install ./searxng-search
pi install ./describe-image
```

在 pi-web Plugins 面板中可看到三个独立包，可单独启用/禁用/卸载。
安装后 `/reload` 或新开会话生效。

## 目录结构

```
pi-web-vitals/
  package.json
  extensions/pi-web-vitals.ts
searxng-search/
  package.json
  extensions/searxng-search.ts
describe-image/
  package.json
  extensions/describe-image.ts
```
