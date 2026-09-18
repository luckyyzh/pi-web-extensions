# Pi Web Extensions

本仓库用于维护 **自定义 Pi 包 + 安装清单 + 经审查补丁**。自定义包源码与 Skill 可独立审阅；安装清单、启动器接入及精确基线的 Windows/SSH 补丁由主项目集成维护，不以复制整份本机环境代替安装。

## 自定义包

| 目录 | 功能 | 配置 / 依赖 |
|---|---|---|
| `searxng-search/` | `web_search` 网络搜索（结果缓存 5 分钟 + 跨引擎 URL 去重，透出 answers/infobox/建议）+ `web_fetch` 静态页面正文抓取 | 自行配置 SearXNG 服务及 `SEARXNG_URL` / `SEARXNG_TOKEN`；支持 `/web-search config url|token <值>` |
| `describe-image/` | `describe_image` 按需调用外部视觉模型 | 自行配置 `VISION_BASE_URL` / `VISION_MODEL` / `VISION_API_KEY`；支持 `/describe-image config baseUrl|model|apiKey <值>` |
| `persona-injector/` | 每轮将用户人设追加到系统提示词 | 读取 `getAgentDir()` 下的 `persona.md`，不附带用户人设 |
| `pi-long-command-guard/` | Windows 长命令守卫、Stop 取消本会话后台任务、恢复后台任务真实终态 | 配合 `pi-better-background-tasks` 和匹配基线的补丁；包含 `background-task-workflow` Skill |
| `ssh/` | 历史 SSH 扩展 | **仅保留历史，默认不安装**；不作为当前 SSH 集成入口 |

每个自定义包都有 `package.json` 与 `extensions/`；guard 另含 `skills/background-task-workflow/SKILL.md`。Skill 随包保留，按需加载。

## 安装与更新约定

主项目启动器的入口为：

- `start-pi-web.cmd`：首启按仓库安装清单安装；普通启动不检查更新。
- `start-pi-web.cmd update [实例名]`：用户手动按仓库清单更新。
- 首次保留已有安装；`update` 更新清单中的 npm 包到指定版本。已有其它路径的本地扩展不覆盖或重复注册。
- 本地包按相对 `agentDir` 的路径注册，不依赖项目 settings。不要把当前工作目录下的相对路径误当成 agentDir 相对路径。

`install-manifest.json` 是安装清单，第三方 npm 包固定版本；`patches/` 保存后台任务插件官方基线与修复文件的校验信息。普通启动只检查首次完成标记，只有显式 `update` 才执行 Git 拉取和包更新。首次运行需 Git、npm 和网络；先发布本仓库的新清单，再使用配套启动器。

## 运行依赖与兼容边界

- guard 的三个扩展只在 Windows 激活；守卫是启发式工作流辅助，不是安全沙箱。
- guard 仍从 `getAgentDir()/npm/node_modules/pi-better-background-tasks/src/` 加载私有模块。主项目须将依赖安装到该位置，并按精确基线恢复经审查的本地 Windows/SSH 补丁。私有 API 或 SDK（包括 `getPowerShellConfig`）不匹配可能导致加载失败或功能降级。
- 浏览器插件还需要上游 **agent-browser CLI >= 0.35（推荐 0.37）** 及可用的浏览器环境；录屏需要 **ffmpeg**。这些外部依赖须另行准备，本次没有自动安装或验证它们。
- 搜索和识图服务需要用户自行配置、授权，可能向所配置的外部服务发送查询或图片。SearXNG 的原有默认服务地址及识图的 DashScope 默认端点保持不变，不代表服务可用或附带访问权限；建议显式配置自己的端点。
- 为保留接口，搜索配置仍位于用户主目录的 `.pi/agent/searxng-config.json`，识图配置仍位于 `.pi/agent/extensions/describe-image-config.json`，不随自定义 agentDir 自动迁移。搜索文件配置优先于环境变量；识图的 API Key 优先使用环境变量，端点和模型优先使用文件配置。

## 来源与审查范围

- `searxng-search`、`describe-image`、`persona-injector` 来自主项目的对应 `vendor/` 安全源码。
- guard 仅收录其 `package.json`、三个扩展源码和一个 Skill；不收录 backups、旧 patches、NOTES-patches 或带本机用户路径的 tests。
- 源码接口保持不变。审阅未发现内置凭据或个人绝对路径，因此未改写业务源码。
- 不复制配置、密钥、登录态、历史、备份、任务日志或用户数据。忽略规则仅是防误提交辅助，不替代提交前审查。
- 代码已做来源、敏感模式、JSON/TypeScript 语法检查。安装流程的验证不代表外部搜索、识图服务或 Windows/SSH/浏览器功能均已验收。
