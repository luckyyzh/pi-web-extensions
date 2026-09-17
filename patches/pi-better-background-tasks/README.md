# pi-better-background-tasks 本地修复

- 官方基线：`pi-better-background-tasks@0.2.12`（npm 发布包）。
- `src/` 是当前已使用的修复后源码；保留上游 MIT `LICENSE`。
- 包含 Windows 无弹窗启动、真实退出码恢复、取消/通知处理以及工具说明调整。这里不重新设计这些功能。
- `manifest.json` 记录官方文件和修复文件的 SHA-256。安装清单指定本补丁后，三个文件先全部校验，再写入；当前文件既不是对应官方基线、已发布修复（可选 `previous` 哈希数组），也不是目标修复时，拒绝覆盖。
- 不直接使用旧机器上的增量 patch：旧 patch 的起点已经有更早的修复，不能应用到原版 npm 包。
- 补丁文件通过 `.gitattributes` 禁止换行转换，确保 Windows/macOS/Linux 的校验一致。

升级流程：先审查新的 npm 版本，再更新安装清单、官方基线 SHA-256 和修复源码/校验值。同版本修复升级时，将上个已发布修复的 `after` 哈希列入 `previous` 数组。不要简单修改版本号或直接执行全局 `pi update --all` 来覆盖这些文件。

此目录不包含运行时任务、日志、机器配置或备份。
