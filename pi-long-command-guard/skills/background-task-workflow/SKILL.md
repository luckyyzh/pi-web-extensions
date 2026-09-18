---
name: background-task-workflow
description: 在 Windows Pi 中执行长命令、构建/安装/全量测试、启动后台进程、等待服务或检查条件、接收后台完成通知及恢复会话时使用。规定 bg_task_spawn/watch/status/log/stop 的选择、PowerShell 执行环境、无忙轮询的任务编排与结果验收。
---

# Windows 后台任务工作流

## 选择执行方式

- 预计可能超过 60 秒的命令用 `bg_task_spawn`；秒级查询、小范围检查用前台 `powershell` / `bash`。`timeout` 是执行上限，不是预计耗时。
- 等待外部条件用 `bg_task_watch`，command 只探测一次，写明确的 success_when；不要在 shell 中写 sleep/轮询循环。
- watch 保留默认 900 秒总超时、30 秒间隔；按需求调整。只有用户确实要求无限监控时才设 timeout_seconds:0。探测命令应只读，并设置其自身合理的请求超时。
- spawn 不强加统一超时，按操作风险和实际需要给预算；不能把超时失败当成成功。

## 保留原执行环境

- bg_task_spawn/watch 的 command 默认交给 Bash，不会跟随前台 PowerShell 工具自动切换。
- PowerShell 代码必须用 `shell:false` 和 `argv:[实际的 PowerShell 可执行文件,"-NoLogo","-NoProfile","-NonInteractive","-Command",原命令]`。从前台配置或已核实的安装路径选择可执行文件；不要猜 pwsh 已安装。
- 传递必要的 cwd/env，保留引号和参数含义。不要把 PowerShell 原文复制到 Bash command，也不要静默换成另一个 PowerShell 版本。
- 守卫拦截表示命令尚未执行；按建议改道。禁止通过删 timeout、反复重试或套另一层 shell 绕过守卫。守卫是性能/工作流辅助，不是安全沙箱。

## 启动之后

1. 保留 task id、任务用途、依赖它的步骤和验收条件；已有 plan 就更新原步骤，不另造一套任务表。
2. 一项操作只启动一次。结果暂时没到，不代表启动失败，不能重复执行安装/构建/迁移等操作。
3. 默认 callback:true。做真正独立且有用的工作，不忙轮询 status/log，不为等结果制造无关修改。
4. 没有独立工作时，说明正在等待哪些 task id，等待完成通知；等待不是完成，不提前将计划标成 completed。
5. 用户明确要求常驻服务时，用单独 readiness 检查验收并说明服务仍在运行；不要等待它自然退出，也不要擅自停止用户要求保留的服务。

## 通知与验收

- 完成通知到达后，先调 `bg_task_status`，确认真实 status/退出码/错误；摘要不足再用 `bg_task_log`，先指定有限 tail_lines，必要时才读取 retained raw log。
- 启动成功不等于任务成功；进程退出 0 也不代替产物、测试结果或业务条件验证。检查并整合结果后才完成父计划步骤。
- 用户要求排查、恢复会话、通知异常时允许一次性查状态；禁止连续查询同一 running 任务来代替等待。
- callback:false 的任务不会通知；除非明确交接给用户管理，不要为需要后续验收的任务禁用 callback。
- 取消不会触发完成通知。Windows 的未发送完成项在原会话恢复后补发，不应唤醒其他会话；不要把“没有通知”解释为成功。

## 共享进度板（多代理/多长任务并行时建议）

当同时有 ≥2 个代理或 ≥2 个较长任务并行、且彼此有依赖或需要互见进展时，建议建进度板；纯串行或秒级任务不必建。是否建板由模型自行判断。

- 目录：`~/.pi/agent/scratch/boards/<board-id>/`。board-id 用短任务名或 4 位随机 hex，父会话生成；给子代理的 prompt 里写绝对路径和该代理的文件名。
- 父会话先写 `README.md`：总目标、任务拆分表（id/任务/文件范围/owner/依赖）、共享接口与关键事实（README 仅父会话可写）。
- 每个代理（含父会话自己）维护自己的 `<board>/agent-<id>.md`：

  ```
  # agent-<id>: <任务名>
  status: running        # running / done / blocked
  ## steps
  - [x] 1. xxx
  - [ ] 2. yyy
  ## notes
  - 关键决策、坑、阻塞（blocked_on: agent-xxx 的产物 <路径>）
  ## deliverable   # done 时填写
  - <产物路径 / 验证输出摘要>
  ```

  板文件里**不写时间戳**：时间以文件 mtime 为准（OS 生成，模型自报的日期/时间不可靠）。判断某代理是否卡住 = 其文件 LastWriteTime 长时间未变且 status 非 done。

- 纪律：每完成一步或遇阻塞即更新自己的文件（一两行即可）；**只写自己的文件**，他人文件与 README 只读；依赖他人产物时先读对方文件，`status: done` 才开工，等待期间先做独立步骤并标注 blocked_on。
- 任务全部验收后删除整个 board 目录。
- 进度板是状态共享，不是消息通道；向运行中的子代理传指令用 `steer_subagent`。

## 停止与失败

- `bg_task_stop` 只针对明确的任务 id。检查返回状态：仍为 running 或包含停止错误就没有确认停成功。
- 用户 Stop 默认取消本会话活跃后台任务；空闲时可由用户执行 `/bg-stop-all`。关闭/重载 Pi 不等于用户要求取消后台进程。
- 任务失败后先检查原因，再决定修复或重试；涉及重要操作仍遵守用户确认要求，不自动反复执行。
- 此流程只保证本地 Windows 行为。SSH direct 的停止不保证远端进程退出；远端安装、取消等沿用其单独授权和限制。
