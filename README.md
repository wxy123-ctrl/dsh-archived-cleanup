# dsh-archived-cleanup

DSH 独立插件：在设置面板「已归档会话」页正下方新增**「归档会话清理」**页，批量勾选已归档会话并**彻底删除**——删除会话在本机 `DSH_HOME` 下的全部落盘痕迹：会话日志（含子代理子会话的全部世代文件 `session.vN.jsonl[.zstd]`）、空项目目录、投影缓存、工作台记账、spill 临时暂存、仅被其引用的附件对象，以及注册表归档集条目。0.3.0 起页面只有一个动作按钮：**删除完成后自动顺带一次全局孤儿清扫**（已无日志的投影缓存与工作台记录、死归档条目、他处空项目目录——幂等，只碰悬空数据）；空选集时按钮即「清扫孤儿数据」，无归档会话时也可单独执行，不再需要第二个按钮。0.4.0 起：「仍在使用」的拒删会话在**页面横幅与结果摘要中单列**，并移除恒为空操作的 `ctx.sessions.refresh()` 调用（客户端 sessions 服务并无该方法，行出列本就依赖 workspace feed 增量）。**0.5.0 起：live 会话免重启即时删除**——删除前按官方 teardown 同款步骤卸载其本进程内存态（cancel 机器 → 拆订阅 → 关持久化写句柄（释放 Windows 文件锁并清 pending 条目）→ 摘 agents 注册表与 sessions store，emit `session/disposed` 令 @ 引用列表/侧栏即时收敛），仅「正在运行回合」的子树仍需先停止；宿主内部可达点逐 hop 探测，任一缺失自动退回「重启后可删」旧语义（`deleteLiveSessions: false` 可显式关闭）。**0.6.0 起新增 `purge-all` 一次性维护入口**：把除 live 会话子树外的全部遗留会话先官方归档再整批删除（须显式确认串，见「调用通道」）。官方将来支持会话删除后，运行 `plugin_manager` `remove_bundle`（或 Plugins 页移除）即可干净剥离：插件不写任何持久状态、不注册设置命名空间。

## 会话数据都保存在哪里（0.1.7-alpha.2 实测清单）

| 数据 | 位置 | 0.2.0 删除行为 |
|---|---|---|
| 会话日志（正文） | `~/.dsh/sessions/<项目>/<encodeSegment(id)>/session.vN.jsonl[.zstd]` | `fs.rm` 整目录（含子树） |
| 空项目目录 | `~/.dsh/sessions/<项目编码目录>/` | 日志删完后目录为空则 `rmdir` |
| 投影缓存（标题/todo/子代理目录/schedule/permissions） | `~/.dsh/storages/session_projcache/sessions/<id>.json` | `storageDomain.get('session_projcache').table('sessions').delete(id)`（官方域正规写链） |
| 注册表归档集 | `~/.dsh/storages/workspace.json` → `global.archivedSessionIds` | 官方幂等 `unarchiveSession` |
| 工作台记账 | 同上 → `tables.workspaces[*].sessionIds` | 对每个工作台官方幂等 `detachSession(id)`（读 raw record） |
| spill 临时暂存（工具输出正文） | `%TEMP%\dsh-spill-*\session-<sha256(id)前12位>\` | 目录名由 id 确定性推导，随删除即刻回收（否则默认 30 天保留） |
| 附件对象（图片/文件本体） | `~/.dsh/attachments/v1/{objects,file-objects,files}/` | 引用感知 GC：仅删独占对象；共享对象保留 |
| 附件请求变体缓存 | `~/.dsh/cache/attachments/request-images/` | 凡有附件被删即整体清空（派生缓存，按需重建） |
| SQLite FTS 全文索引 | 本组合 `:memory:`；文件型部署为独立 db | 派生数据，官方按 `persistence.list()` 对账自愈，无需处理 |

**本地无法删除、如实声明的项**：官方 DeepSeek API 的会话日志远端增量上传（`dsh-session-log-deepseek`，走官方 API 时启用）、telemetry(otel) 后端远端投递、`AppData\Roaming\DSH\manager.log` 中的生命周期行、WebView2 `Local Storage` 的 UI 状态快照（无正文，刷新后列表自愈）。

## 工作原理

- **宿主半边**（`index.js`）：宿主没有会话删除原语（`SessionPersistence` 无 `delete`，产品决策「会话可归档但绝不删除」），本插件在文件系统与存储域层完成删除，顺序为：
  0. 【删除前】子树成员三分区（0.5.0）：`agents.get(id).status === 'running'` 的成员 → 整棵子树拒绝（`status: 'busy'`，先停止）；live 且空闲的成员（运行时卸载能力可用时）→ 按官方 teardown 同款步骤卸载内存态：`agent.cancel({kind:'disposed'})` → `agent.scope.dispose()`（拆机器订阅，缺席/失败留作惰性残留）→ 持久化写句柄 `close()`（官方公开幂等 API：drain 缓冲 → 释放跨进程写锁 → 清 pending 条目；Windows 下不关句柄文件锁在、删除必败，故本步失败即整根拒删）→ agents 注册表条目 `detach()` → sessions store 条目 `detach()`（emit `session/disposed`，客户端与 `sessionQuery` 即时收敛）。卸载能力探测（`sessions.store` / `agents.store` / `sessionPersistence.tracker.writers` 逐 hop feature-detect）任一缺失或 `deleteLiveSessions: false` → live 子树退回「重启后可删」旧语义（`status: 'live'`），绝不半套卸载；
  1. 【删除前】读子树成员日志收集附件引用（live 成员优先用 `session.snapshotEvents()` 内存快照——含未落盘缓冲，比冷读更准；冷成员走官方 `persistence.resolveCurrentLog` + `readStoredLog` 公开读路径），全量序列化扫描收集 `sha256:` 附件 id（收集与独占检查同一扫描器，天然对称；读不出的成员其附件保留，安全方向）；
  2. `fs.rm` 会话日志目录，空项目目录顺手 `rmdir`；
  3. 投影缓存：取官方 `sessionProjectionCache` 服务**已打开**的同一 `session_projcache` 域（`storageDomain.open` 对已打开名抛 `already-open`，必须走 `storageDomain.get`），`table('sessions').delete(id)` 走持久化+内存同删并触发 `domain/changed`；
  4. 工作台记账：对 `registry.list()` 每个工作台调官方 `Workspace.detachSession(id)`（幂等 no-op；实体 `sessionIds` getter 会被 header 索引过滤，故统计命中读 raw `record.sessionIds`）；归档集走官方 `unarchiveSession`（旧版经 `enqueueOperation/requireState/setState` 复刻同一写路径）——`setState` 先持久化 domain global、再更新内存并触发 `domain/changed`，WorkspaceFeed 向所有客户端发布增量，官方「已归档会话」页与侧栏自动收敛；
  5. spill 暂存：`session-<sha256(id).slice(0,12)>`（宿主 `spill-local.sessionDir` 同款公式），在配置的 `spillRoots` + `os.tmpdir()` 下发现的 `dsh-spill-*` 根中删除（保留官方保留名 `session-backup`，其不匹配 12 位十六进制后缀）；
  6. 附件 GC：日志已删后 `persistence.list()` 只剩幸存会话，逐个读其日志扫描候选 id——全部未被引用的对象删除（`objects/<2>/<sha>` 图片、`file-objects/<2>/<sha>` 文件对象、`files/<2>/<sha>/` 带名别名目录），任一被引用则保留该对象；删过至少一个对象即整体清空 `request-images` 派生缓存。`purgeAttachments: false` 可整体关闭；读日志/扫描失败一律保留附件（fail-safe）。
  7. 全文索引（sqlite，文件型部署）在下次 list/search 时按 `persistence.list()` reconcile 自愈；行的出列依赖 workspace feed 增量（`unarchiveSession` → `domain/changed` → WorkspaceFeed `archived` 增量），无需（也没有）客户端 refresh 原语。
- **浏览器半边**（`client.js`）：经 `settings.section` 插槽注册设置页（order 26，官方已归档页 25 与插件页 30 之间）。行数据与官方页同源（归档集 ∩ 已加载 summaries）；status 预标注 live 子树与残留面（缓存/工作台记录/暂存标记）；归档集中无 summary 的死条目单独分组。导航行图标同样是浏览器侧 DOM 协调（宿主壳图标按 section id 写死、Slot 契约无图标位）：按本节 label 匹配导航按钮，隐藏齿轮、插入宿主 `IconTrashOutline16` 同款垃圾桶，插件卸载时还原。工具条唯一动作按钮双形态：有勾选时「彻底删除…」（红色），空选集时「清扫孤儿数据…」（中性描边；无归档会话时工具条也渲染，清扫始终有入口）。二次确认走宿主 `Modal`/`Button` 原语（`require('@deepseek-ai/dsh-client-ui-primitives')`，shell 静态模块表；识图模式清理确认同款——运行中 Esc/遮罩/取消不关窗，请求级失败保留对话框展示错误，成功即关窗）。结果摘要逐类显示清理计数与 warnings（辅助清理失败不阻断，重跑收敛），以及内联清扫的计数行；0.4.0 起「仍在使用」的拒删行（`status: 'live'`）单列提示并在列表顶部按 status 预标注显示常驻横幅（数量与行内「使用中」标注一致）。
- **调用通道**：静态挂载插件没有 host.call 通道，借用宿主 `webServer` 服务的命名路由（同源 POST；Host/Origin 信任围栏为官方 `/api` `isTrustedApiRequest` 同款语义——Host 回环（或 0.0.0.0 部署）经 URL 归一化判定、`sec-fetch-site: cross-site` 拒绝、Origin 缺席放行（桌面壳 `dsh-app://app` 经 Electron 主进程转发的请求没有 Origin 头，0.3.x 的字面同源检查曾因此 403 cross-origin request rejected）、Origin 存在须与 Host 同权；`dsh-vision-tool` 同款先例）：
  - `POST /plugins/dsh-archived-cleanup/status` `{ids}` → `{ok, liveTeardown: {capable, missing}, results}`，每行 `{archived, blockedLive, busy, liveIdle, liveCount, subtreeSize, hasLog, hasCache, workspaceRefs, hasSpill}`（`blockedLive` = busy ∨ (liveIdle>0 ∧ 卸载不可用)，兼容旧客户端）。
  - `POST /plugins/dsh-archived-cleanup/delete` `{ids}`（可为空数组=纯清扫）→ 逐根 `{id, status, message?, removed?, missing?, tornDown?, cachePruned?, detachedWorkspaces?, spillRemoved?, attachmentsRemoved?, attachmentsKeptShared?, warnings?}`（`status: 'busy'` = 拒删：正在运行；`status: 'live'` = 拒删：仍在使用且卸载不可用）；**完成后总是再执行一次全局孤儿清扫**，响应另含 `sweep: {results, warnings}`（清扫失败不拖垮删除结果，降级为 `sweep.warnings` 一条错误）。
  - `POST /plugins/dsh-archived-cleanup/sweep` `{}` → `{cachePruned, workspacesDetached, deadArchivedPruned, spillRemoved, emptyProjectDirs, warnings}`，幂等的独立清扫入口（UI 已不再调用，供脚本与手动二次校验：正确状态下应全为 0）。
  - `POST /plugins/dsh-archived-cleanup/purge-all` `{confirm: 'purge-all-except-live', keepIds?: []}`（0.6.0 一次性维护入口，**破坏性**，须显式确认串，不进 UI）→ 先逐个官方 `archiveSession` 归档「除 live 会话及其持久化后代（∪ keepIds）外」的全部会话（feed 增量即时收敛），再复用 delete 的全部管线删除；候选 = 磁盘 ∪ 工作台记账 ∪ projcache 表 ∪ 归档集（未挂靠/死数据一并纳入）。响应 `{ok, excluded, archivedCount, results, sweep, warnings}`。用途：一次性清空历史遗留，让 @ 列表只剩当前会话子树；多开标签页打开的其他会话因 live 自动豁免。

## 删除规则（安全边界）

- 仅接受**归档集内**的 id（请求时现读注册表），路由不是任意目录删除入口；`encodeSegment` 在编码层中和路径穿越。
- **子树整体判定**：目标及其全部后代（`parentSession` 传递闭包，live + 持久化头部合并计算）。正在运行回合（`agents.get(id).status === 'running'`）的成员 → 整棵子树拒绝（`status: 'busy'`，停止后即可删）。live 且空闲的成员：0.5.0 起按官方 teardown 同款步骤运行时卸载后照常删除（宿主无公开的 per-agent dispose API——`AgentHandle` 的 dispose 能力被 session-controller 丢弃，`FactoryOwnership.liveAgents` 是无主 Set——插件经逐 hop 探测的内部可达点 `sessions.store` / `agents.store` / `sessionPersistence.tracker.writers` 自组合官方 teardown 的每一步：cancel → scope dispose → 写句柄 close → 双注册表摘除，全部幂等或容错，见工作原理第 0 步）；任一可达点缺失或 `deleteLiveSessions: false` → 退回「重启 DSH 后可删」旧语义。拒删（busy）是承重的：`sessionQuery.listSessions` 为 live-preferred，对运行中的会话强行删盘会与正在追加的事件流竞态。
- **附件宁可漏删不可误删**：独占检查覆盖全部幸存持久化日志；读不出日志、sessionPersistence 缺席、扫描异常时保留全部候选附件。
- 辅助清理（缓存/记账/spill/附件）单步失败只记 `warnings`，不回滚已删日志；日志删除与归档条目清理失败维持 `error` 语义；单成员失败（如 Windows 下日志文件被占用 EBUSY）只中断该根，其余照常；重跑幂等收敛（磁盘已缺的成员按 missing 跳过）。

## 清理范围与 @ 引用列表（读宿主源码实证）

输入框 `@` 提及的候选列表（`dsh-client-ui-reference` → 宿主 `sessionReferenceResolver.remoteExportCandidates` → `sessionQuery.listSessions`）**每次按键实时查询**，无客户端缓存，其语料为三者并集：

1. **live 内存 store**（`ctx.sessions.list()`）——本进程打开/创建过的全部会话。DSH 无公开卸载接口，**归档只隐藏不卸载**，会话在进程重启前一直驻留；
2. **磁盘日志实时扫描**（`sessionPersistence.list()`，`sessions/<项目>/<id>/`）——所有项目的全部会话；
3. **本进程 created-but-unmaterialized 的 pending 条目**（必然同时 live，已被第 1 项覆盖）。

因此两者的范围天然不对齐：

| @ 列表里看到的 | 本插件能否清理 |
|---|---|
| 已归档、整个子树已冷的会话 | ✅ 勾选删除即彻底移除，@ 中随之消失 |
| **已归档但本进程仍在使用（空闲）的会话** | ✅ 0.5.0 起删除时先运行时卸载内存态（免重启），@ 与侧栏即时消失；能力不可用（内部可达点缺失/显式关闭）时退回 ❌ 重启后可删 |
| 已归档但正在运行回合的会话 | ❌ 先停止（归档操作通常已停止），停止后即可删 |
| 未归档的冷会话（任何项目） | ❌ 不在归档集，须先在官方页归档再回来删 |
| 子代理会话 | 随父会话子树删除（live 空闲的同样先卸载）；父会话未归档时不可单独删 |
| 其他项目/工作区的会话 | 同上规则，与当前工作区无关 |

判定口诀：**@ 里以裸 id 显示的会话 = 无标题投影的会话**；删除被拒的会话一切照旧（磁盘/缓存/记账均在），删除成功的会话因宿主实时查询即刻从 @ 消失（live 会话的内存态已在删除中卸载）——若 @ 仍能看到某个 id，说明该会话要么删除被拒（busy/live），要么从未被删除，不存在「删了磁盘但 @ 仍残留」的路径。0.3.x 观感缺陷：清扫完成后页面显示「孤儿清扫完成：…全 0」，而真正的阻塞（live 待重启）只是行内灰字，用户无从得知「为什么 @ 里还在」——0.4.0 起以页面横幅 + 结果摘要单列修复，0.5.0 起从根上取消该阻塞。

## 挂载 / 剥离（官方 bundle 安装）

```cmd
git clone https://github.com/wxy123-ctrl/dsh-archived-cleanup.git
plugin_manager install_bundle  target=<本仓库绝对路径>   :: 安装并启用（或 Web 侧 Plugins 页）
plugin_manager remove_bundle   target=dsh-archived-cleanup         :: 卸载（或 Plugins 页移除）
```

`package.json` 声明 `dsh.bundle.patch` → 本目录 `cordis.patch.yml`（`insert`
行 `{id: archived-cleanup, name: dsh-archived-cleanup}`），补丁由 bundle 层
自动合成——**无需 junction、无需手工编辑 profile 的 `cordis.patch.yml`**。
web 模板 `patchReload: live`：启停即热生效，浏览器半边随 HMR 同步（已打开页面免刷新）。

可选行 config（默认无需配置），在 profile 的 `cordis.patch.yml` 按 id 覆盖：

```yaml
- id: archived-cleanup
  name: dsh-archived-cleanup
  config:
    sessionsRoot: 'D:/elsewhere/sessions'      # 覆盖过 session-persistence-jsonl 的 root 时
    attachmentsRoot: 'D:/elsewhere/attachments/v1'  # 覆盖过附件存储布局时
    spillRoots: ['D:/elsewhere/spill']         # 额外的 spill 根（os.tmpdir() 自动发现仍生效）
    purgeAttachments: false                    # 关闭附件 GC（默认 true）
    deleteLiveSessions: false                  # 关闭 live 运行时卸载，退回「重启后可删」（默认 true）
```

**宿主半边的热加载工作流（不重启 DSH，本地开发选读）**：若部署的 hmr
`root: []`（模块文件监听关闭），且 Loader 停用/启用复用 Node ESM 按 URL
命中的缓存——裸包名解析出的 URL 恒定，改 `index.js` 后必须换 URL 才会
重新导入。本地可把 profile 补丁里本插件的 `name` 覆盖为
`file:///<本仓库绝对路径>/index.js?t=<N>`（file:
URL 不经过补丁层的相对路径锚定，`?` 不会被编码成 `%3F`）。每次修改
`index.js`：递增 `?t=` → `plugin_manager set_bundle` 停用再启用 → 宿主即载入
新代码；`client.js` 本来就随页面刷新获取。**只改 `client.js` 无需动 t。**

## 自测与验收

```cmd
node selftest.mjs          :: 46 项纯函数 + 临时目录端到端（encodeSegment / 子树闭包 / live 三分区（busy 拒绝 · 运行时卸载先行 · 卸载失败整根拒删 · 旧语义回退）/ 幂等重跑 / 空选集纯清扫前提 / 归档条目清理版本自适应 / 附件收集与独占 GC（含 live 快照源）/ spill 推导 / 缓存+记账+空目录清理 / 孤儿清扫幂等 / 删除+内联清扫合并语义 / live 卸载能力探测与官方步骤顺序 / purge-all 排除闭包·候选并集·确认门·端到端）
```

验收清单：

1. `dsh web --dump-config | findstr archived-cleanup` 出现该行。
2. 设置面板出现「归档会话清理」页（「已归档会话」正下方）。
3. 归档冷会话 → 全选 → 确认（宿主原生对话框，非浏览器弹窗；运行中不可关窗）→ 资源管理器验证：`sessions/<项目>/<id>/` 目录消失、项目目录（若空）消失、`storages/session_projcache/sessions/<id>.json` 消失、`workspace.json` 的 `archivedSessionIds` 与 `workspaces[*].sessionIds` 均无该 id、`%TEMP%\dsh-spill-*\session-<hash12>/` 消失、独占附件对象消失（共享保留）；官方已归档页、侧栏、本页行全部消失；刷新页面后不复活。同一响应的结果区出现「孤儿清扫完成：…」计数行。
4. 不勾选任何会话（或归档集为空）→ 按钮呈「清扫孤儿数据…」→ 原生确认对话框 → 本机历史残留（无日志的 projcache、悬空工作台记账、死归档条目、空项目目录）全部列出并清除；二次执行全为 0。删除会话后无需再点第二次——内联清扫已随之执行。
5. **live 即删（0.5.0 核心验收）**：在同一 DSH 进程内开一个新会话说一句话 → 侧栏归档它 → **不重启**进本页：该行可选且标注「使用中 · 删除时将先卸载内存态」→ 确认删除 → 结果摘要含「内存态卸载 1」→ 在任意对话框输入 `@`：该 id 即时消失；资源管理器验证日志目录已删；若它曾开在标签页，该标签页失效（关闭即可）。
6. 正在运行的归档会话（如正在执行工具调用的会话被归档）行标注「正在运行 · 停止后可删」且不可勾选；强删（构造 status 标注与 delete 之间的竞态）返回 `status: 'busy'`，结果摘要单列为「未删除（正在运行）」，不混入失败列表。
7. `plugin_manager` `remove_bundle` 后 `dump-config` 无残留、Plugins 清单消失。

## 已知限制

- 正在运行回合的会话需先停止才能删除（删除的是已归档会话，归档操作通常已停止活动）。live 且空闲的会话 0.5.0 起免重启即时删除；运行时卸载依赖宿主内部可达点（`sessions.store` / `agents.store` / `sessionPersistence.tracker.writers`），DSH 升级若改名则自动退回「重启后可删」旧语义——降级不误删、不半删。
- 删除「正在执行本次删除请求的会话」会中断该会话自身（自删），文档声明即可，不做拦截。
- agent 机器若个别订阅无法拆除（scope 缺席），残留为惰性对象（session 已摘、无事件流入），等待 GC/重启，不影响可见性与数据。
- 删除绕过持久化层，无 `session/persistence/deleted` 事件：客户端列表与文件型 sqlite 索引靠 reconcile/feed 增量自愈（进行中的搜索结果可能短暂残留）。
- 附件独占检查覆盖全部**已持久化**日志与 live 成员的内存快照；本进程新建未落盘会话与被删对象共享同一附件的概率可忽略（附件先落盘、会话事件后写），误删时读取会响亮报错而非返回错误字节。
- 未持久化会话（本进程创建、零 append）的目录本就不存在，重跑按 missing 收敛；其 pending 条目随写句柄 `close()` 的 `releaseHandle` 一并清除。
- 远端痕迹（官方 API 日志上传、telemetry）与 `manager.log`、浏览器 Local Storage 属平台层，不在插件删除范围。
- 删除中文件被占用（如该会话历史页正打开）→ 该根报错，稍后重试。

## 许可证与声明

MIT，见 [LICENSE](./LICENSE)。

- 本插件为社区作品，与 DeepSeek / 深度求索不存在隶属、合作或官方背书关系；
  「DeepSeek Harness」为深度求索的商标，此处仅作兼容性引用，插件名使用
  官方推荐的 DSH 缩写。
- 本插件仅经本 GitHub 仓库分发，未发布到 npm。
- **破坏性工具提示**：本插件会永久删除本地会话数据，使用前请阅读上文
  「删除规则（安全边界）」并自行做好备份。
