# 版本隔离、资源实体库与游玩统计

2026-10 定稿。实现入口：`src/main/resources.ts`、`src/main/playtime.ts`、`src/main/instances.ts`。

## 1. 版本隔离

- 全局设置 `versionIsolation`，默认 **开启**
- 开启：游戏 `--gameDir`/cwd = `instances/<id>/`，`mods / saves / config / options.txt / resourcepacks / shaderpacks` 独立
- 关闭：`--gameDir`/cwd = 根目录，所有实例共享上述目录
- 整合包实例（`berry.json.pack` 存在）**始终强制隔离**
- 切换只影响后续启动，不自动搬移文件
- 所有路径判断统一走 `instanceGameDir()`，禁止在业务代码里散落 `versionIsolation` 判断

## 2. 资源实体库

位置跟启动器走：`<dataDir>/resources/<sha1>`（不是 gameDir）。

- 同一 SHA-1 的 mod / 材质包 / 光影只保留一个实体
- 实例目录里通过 `fs.linkSync` 创建硬链接；失败（跨卷、exFAT）自动退化为复制
- 实体文件设为只读（POSIX 0444 / Windows 只读属性），实例链接继承；防止直接覆盖实体污染所有实例
- 只对 `.jar` / `.zip` 等不可变资源去重；`config`、`saves`、`options.txt` 不做
- 删除实例/模组后，实体 `nlink <= 1` 时由 `storage.gc()` 清理
- 跨卷时检测 `stat.dev`，不做「实体 + 副本」的伪去重，直接跳过并记录错误

### 自动瘦身

- 默认 **关闭**，首次检测到实例后弹一次建议
- 开启后：启动器空闲/启动时扫描各实例的 `mods`、`resourcepacks`、`shaderpacks`
- 只处理 ≥64KB 的 `.jar/.zip`，按 `path + size + mtime` 缓存 SHA-1
- 已硬链接（`nlink>1`）跳过；新文件移入实体库再链接；已存在的重复文件删掉后改为链接
- 扫描任务走统一 TaskManager（kind=`storage`），UI 可在下载页看到进度
- 支持手动「立即整理」；不默认全盘扫描，避免首次启动卡顿

### 修改与导出

- 实体只读，玩家要改资源必须走「复制到实例并解锁」
- 安装/整理时记录 `<dataDir>/manifests/<instance>.json`：`{baseSha1, sha1, linked}`
- 导出时逐个文件重新 hash，与清单比较；只打包新增/修改文件，并附 `berry-resource-manifest.json`（整文件 + 变更清单，不做二进制 patch）
- 导出位置：`<dataDir>/exports/<instance>-resources-<timestamp>.zip`

## 3. 游玩时长

- 账本：`<dataDir>/playtime.json`，不复用 `berry.json.playTimeSec`
- 启动成功后写 `active`，每 20 秒更新 `lastHeartbeat`
- 正常退出结算并写 session；启动器崩溃后下次启动按 `lastHeartbeat` 结算，不把停机时间算进去
- 首次启用时迁移旧 `playTimeSec`，用 `migrated` 列表防重复导入
- 聚合：按实例、按 MC 版本、总计；删除实例后保留统计并标记 `deleted`
- 同时运行多个实例时总时长按各自运行时间相加（不是墙钟）
- 启动器退出时结算到退出时刻；游戏若继续运行，后续时间不再计入（已知限制）

## 4. 验收

- 两个实例放同一个 Sodium jar：`nlink=3`，实体只有一份，`usage.savedBytes` 增加
- 手动拖入重复材质包后「立即整理」：链接建立、只读、节省字节正确
- 修改/新增一个文件后导出：zip 内只有该文件 + 清单
- 强杀启动器后重启：时长按最后心跳恢复，不清零
- 关闭版本隔离后启动：`# args` 中 `--gameDir` 为根目录；整合包仍为实例目录
