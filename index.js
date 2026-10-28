// dsh-archived-cleanup — host half.
//
// 已归档会话批量彻底删除（独立插件，官方 session.delete 落地后可整体剥离）。
//
// 「彻底」= 会话在本机 DSH_HOME 下的全部落盘痕迹（0.2.0 起）+ 本进程的
// live 内存态（0.5.0 起，免重启即时删除）：
//   1. 会话日志目录 sessions/<项目>/<encodeSegment(id)>/（含子代理子树与
//      全部世代文件 session.vN.jsonl[.zstd]）——文件系统层 fs.rm 整目录，
//      删完后项目目录若已空则顺手 rmdir；
//   2. 投影缓存 storages/session_projcache/sessions/<id>.json（标题、todo、
//      子代理目录、schedule、permissions 等真实会话内容）——经
//      storageDomain.get('session_projcache') 取官方服务已打开的同一域，
//      table('sessions').delete(id) 走持久化+内存同删的正规写链；
//   3. 注册表归档集 + 工作台记账 storages/workspace.json——前者直调官方幂
//      等 unarchiveSession（旧版经内部写路径复刻），后者对每个工作台调官方
//      Workspace.detachSession(id)（幂等 no-op，操作 raw record，不受实体
//      getter 的 header 索引过滤影响）；
//   4. spill 暂存 %TEMP%\dsh-spill-<进程>\session-<sha256(id)[0..12]>\——
//      目录名由会话 id 确定性推导（宿主 spill-local sessionDir 同款公式），
//      官方 30 天保留期之前即随删除回收；
//   5. 附件对象 attachments/v1/{objects,file-objects,files}/——引用感知 GC：
//      删除前先读子树日志收集 sha256 附件 id，删除后扫描全部剩余持久化日志，
//      仅当无任何幸存会话引用时删除对象（含带文件名的 files 别名），并整体
//      清空 request-images 派生变体缓存（按需重建）。读不出日志/扫描失败
//      一律保留附件（fail-safe）。config purgeAttachments:false 可整体关闭。
//   6. live 内存态（0.5.0）——官方 teardown 同款步骤的运行时卸载：cancel
//      机器 → 拆机器订阅 → 关持久化写句柄（释放 Windows 文件锁 + 清 pending
//      条目）→ agents 注册表摘除 → sessions store 摘除（emit
//      session/disposed，客户端即时收敛）。正在运行回合（running）的子树
//      仍拒绝（先停止）；内部可达点逐 hop feature-detect，任一缺失整体
//      退回「live 拒删 + 提示重启」旧语义，绝不半套卸载。
//
// 另设孤儿清扫：projcache 中既无日志目录又非 live 的记录、工作台 raw
// sessionIds 中同样悬空的 id、归档集中的死条目、sessions 根下的空项目
// 目录——修复历史删除留下的残留。0.3.0 起 /delete 完成后总是顺带执行一次
// （单按钮语义：删除即清扫；空选集 {ids: []} 即纯清扫）；/sweep 路由保留
// 为幂等的独立入口，供脚本与二次手动校验。
//
// 安全边界：
// - 仅接受归档集中的 id（请求时现读注册表），路由不是任意目录删除入口；
// - encodeSegment 逐字复制自宿主 format.ts（纯函数），转义一切非
//   [A-Za-z0-9._-] 字符与 `~`，路径穿越在编码层被中和；
// - 子树整体判定：目标及其全部后代中任一会话在本进程内 live——running 的
//   整棵子树拒绝（先停止）；live 且空闲的经 0.5.0 运行时卸载后照常删除，
//   卸载能力不可用（内部可达点缺失或 deleteLiveSessions:false）时退回
//   「重启 DSH 后可删」的旧语义；
// - 辅助清理（缓存/记账/spill/附件）失败只记 warnings，不回滚也不阻断；
//   日志删除与归档条目清理失败维持既有 error 语义；
// - 路由信任围栏（官方 /api isTrustedApiRequest 同款语义，见下方内联副本）：
//   Host 回环绑定（或 0.0.0.0 部署）、显式跨站标记拒绝；Origin 缺席放行
//   （桌面壳转发无 Origin——0.3.x 字面同源检查曾因此 403），存在则须与
//   Host 经 URL 归一化后同权。
//
// 本地无法删除、README 如实声明的项：官方 DeepSeek API 的会话日志远端上传
// （dsh-session-log-deepseek）、telemetry 后端远端投递、manager.log 中的
// 生命周期行、WebView2 Local Storage 的 UI 状态快照。SQLite FTS 索引为派生
// 数据（本组合 :memory:），文件型部署在下次搜索时按 persistence.list() 自愈。
//
// 静态挂载插件没有 host.call 通道（那是动态 Cordis 插件体系的），借用宿主
// webServer 服务的命名路由作浏览器半边的调用通道（dsh-vision-tool 先例）。
// 路由注册走 ctx.inject 回调而非 apply 时的 ctx.get：本插件行可能在
// webServer 服务激活前进店，回调形式在服务就绪时注册、被替换时自动重挂。

import { readdir, rm, rmdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// ── 0.6.0 维护入口：purge-all（保留 live 子树的遗留数据全量清理）──────────
//
// 场景：用户明确要求「把以前遗留的会话全部清掉，@ 列表只剩当前会话」。这批
// 会话大多未归档，不满足 delete 路由的「仅归档集」安全边界——本入口先逐个
// 走官方 archiveSession 写链（feed 增量即时收敛到侧栏/官方归档页），再复用
// performCleanup 的全部既有管线与 fail-safe（busy 拒绝、live 运行时卸载、
// 附件独占 GC——此时幸存者只剩 live 子树，其引用的附件自动保留）。
//
// 排除集 = 全部 live 会话 ∪ 其持久化后代（parentSession 传递闭包）∪ 请求
// 显式 keepIds：其他标签页打开的会话因 live 自动豁免。候选集 = 磁盘全部
// 持久化会话 ∪ 工作台记账 ∪ projcache 表 ∪ 归档集（不依赖单一注册表，
// 未挂靠/死数据一并纳入）。破坏性入口必须携带显式确认串，不进 UI。

/**
 * 计算 purge-all 的排除集与候选集。
 * @param {object} deps - 见 apply 内 routeDeps（需 liveIds/headers/archivedIds/
 *   accountedIds/cacheIds）。
 * @param {string[]} [keepIds] - 额外显式保留的会话 id。
 * @returns {Promise<{excluded: Set<string>, candidates: string[]}>} 排除集与删除候选。
 */
export async function planPurge(deps, keepIds = []) {
  const headers = await deps.headers()
  const childrenOf = buildChildrenMap(headers)
  // live 及其全部持久化后代入排除集（BFS；live 之间互为对方子树时亦收敛）。
  const excluded = new Set(keepIds.map(String))
  const queue = deps.liveIds().map(String)
  while (queue.length > 0) {
    const id = queue.pop()
    if (excluded.has(id)) continue
    excluded.add(id)
    for (const child of childrenOf.get(id) ?? []) queue.push(String(child))
  }
  const candidates = new Set()
  for (const header of headers) candidates.add(String(header.id))
  for (const id of deps.accountedIds()) candidates.add(String(id))
  for (const id of deps.cacheIds()) candidates.add(String(id))
  for (const id of deps.archivedIds()) candidates.add(String(id))
  for (const id of excluded) candidates.delete(id)
  return { excluded, candidates: [...candidates] }
}


//
// ── 路由信任围栏（官方 /api 同款语义的内联副本，dsh-vision-tool 同款）────
//
// 官方 /api 路由的 Host/Origin 围栏在 packages/client/connection/src/
// api-request-trust.ts（isTrustedApiRequest），语义四条：
//   1) Host 必须可解析为 authority，回环绑定的部署里 hostname 必须回环
//      （DNS-rebinding 防御：rebound 请求的 Host 是攻击者域名）；
//   2) sec-fetch-site: cross-site 显式跨站标记直接拒绝；
//   3) Origin 缺席视为可信——桌面 GUI 的 dsh-app://app 壳经 Electron 主进程
//      转发（apps/desktop/src/web-document.ts forwardWebRequest）时
//      host/origin/sec-fetch-site 会被删除，路由必须放行这种请求；
//   4) Origin 存在则与 Host 经 URL 归一化后同权比较（默认端口/大小写归一，
//      'null' 解析失败拒绝）。
// 独立插件无法 import 该官方包内模块，就地内联同一判定（纯函数零依赖）。

/**
 * 单个请求头的字符串值；数组形态（畸形请求）按缺失处理。
 * @param {import('node:http').IncomingMessage} req - node:http 请求。
 * @param {string} name - 头名（小写）。
 * @returns {string | undefined} 字符串值，或 undefined。
 */
const headerValue = (req, name) => {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * 是否回环 hostname（localhost / [::1] / 127/8 内任意 IPv4）。
 * 与官方 loopback-hostname.ts 同款；hostname 来自 WHATWG URL 解析，
 * IPv6 字面量保留方括号。
 * @param {string} hostname - URL 解析出的 hostname。
 * @returns {boolean} 回环则 true。
 */
const isLoopbackHostname = (hostname) => {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * 官方 /api 信任围栏的内联同款：三条路由共用。Origin 缺席放行（桌面壳
 * 转发即此形态），Origin 存在须与 Host 同权；Host 非回环仅在 0.0.0.0
 * 部署（lanDeployment）放行；显式跨站标记一律拒绝。
 * @param {import('node:http').IncomingMessage} req - node:http 请求。
 * @param {boolean} lanDeployment - webServer 绑定 0.0.0.0（局域网可达）时为 true。
 * @returns {boolean} 请求可信则 true。
 */
const isTrustedPluginRequest = (req, lanDeployment) => {
  const hostHeader = headerValue(req, 'host')
  if (hostHeader === undefined) return false
  let hostUrl
  try { hostUrl = new URL(`http://${hostHeader}`) } catch { return false }
  const loopback = isLoopbackHostname(hostUrl.hostname)
  if (!loopback && !lanDeployment) return false
  if (headerValue(req, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerValue(req, 'origin')
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

export const name = 'dsh-archived-cleanup'

// 无 Config schema：行 config 原样传入 apply，可选项 sessionsRoot /
// attachmentsRoot / spillRoots / purgeAttachments（默认与宿主同款布局）。

/** DSH 主目录：DSH_HOME 环境变量优先，缺省 ~/.dsh（宿主同款语义）。 */
export function dshHomeOf(env = process.env) {
  return env.DSH_HOME && env.DSH_HOME !== ''
    ? resolve(env.DSH_HOME)
    : join(homedir(), '.dsh')
}

/**
 * 宿主 encodeSegment 的逐字复制（packages/session/session-persistence-jsonl
 * /src/format.ts）：把字符串编码为单个安全路径段。安全字符原样保留，其余
 * （含 `~` 与分隔符）转义为 `~XXXX`；`.`/`..` 整段特判，路径穿越被中和。
 * @param {string} raw - 会话 id。
 * @returns {string} 编码后的路径段（即磁盘上的会话目录名）。
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

/**
 * 在 sessions 根下定位一个会话的全部目录：遍历项目目录，收集名为
 * encodeSegment(id) 的子目录。扫描而非按 cwd 计算路径，天然容忍项目目录
 * 命名（projectKey）变化与 _no-cwd。根不存在返回空数组。
 * @param {string} sessionsRoot - 会话日志根目录。
 * @param {string} id - 会话 id。
 * @returns {Promise<string[]>} 全部命中的会话目录绝对路径。
 */
export async function findSessionDirs(sessionsRoot, id) {
  const encoded = encodeSegment(id)
  const hits = []
  const projects = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => undefined)
  if (projects === undefined) return hits
  for (const entry of projects) {
    if (!entry.isDirectory()) continue
    const candidate = join(sessionsRoot, entry.name, encoded)
    const info = await stat(candidate).catch(() => undefined)
    if (info !== undefined && info.isDirectory()) hits.push(candidate)
  }
  return hits
}

/**
 * 由「id + 可选 parentSessionId」表构建 parent -> children 索引。
 * @param {Array<{id: string, parentSessionId?: string}>} headers - live 与持久化合并的会话头部。
 * @returns {Map<string, string[]>} 每个父会话的直接子会话 id 列表。
 */
export function buildChildrenMap(headers) {
  const children = new Map()
  for (const header of headers) {
    if (!header || typeof header.id !== 'string') continue
    const parent = header.parentSessionId
    if (typeof parent !== 'string' || parent === '') continue
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(header.id)
  }
  return children
}

/**
 * 目标会话的完整子树（含自身）：parentSession 传递闭包。
 * @param {string} root - 目标会话 id。
 * @param {Map<string, string[]>} childrenOf - buildChildrenMap 的结果。
 * @returns {Set<string>} 子树全部成员 id。
 */
export function subtreeOf(root, childrenOf) {
  const subtree = new Set([root])
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.pop()
    for (const child of childrenOf.get(current) ?? []) {
      if (!subtree.has(child)) {
        subtree.add(child)
        queue.push(child)
      }
    }
  }
  return subtree
}

/**
 * 把一个 id 清出 workspaceRegistry 的归档集（幂等，不校验会话存在性——
 * 移除不可能引入未知 id，已清出的条目直接决议）。版本自适应：
 * - 0.1.6+ 的 registry 提供公开方法 unarchiveSession，优先直调；
 * - 更旧版本只有单向 archiveSession，退回用 registry 内部的
 *   enqueueOperation + requireState + setState 逐字复刻 0.1.6 的官方实现
 *   （packages/workspace/workspace/src/index.ts unarchiveSession）：写入经
 *   enqueueOperation 与其他注册表写串行，setState 先持久化 domain global、
 *   再更新内存并触发 domain/changed，WorkspaceFeed 据此向所有客户端发布
 *   archived 增量——与官方方法同一条持久化与通知链。
 * @param {object|undefined} registry - wctx.get('workspaceRegistry') 的现值。
 * @param {string} id - 要清出归档集的会话 id。
 * @returns {Promise<void>} 持久化完成后的决议。
 */
export async function unarchiveRegistryEntry(registry, id) {
  if (registry === undefined) throw new Error('workspaceRegistry 服务不可用')
  if (typeof registry.unarchiveSession === 'function') {
    await registry.unarchiveSession(id)
    return
  }
  if (typeof registry.enqueueOperation !== 'function'
    || typeof registry.requireState !== 'function'
    || typeof registry.setState !== 'function') {
    throw new Error('workspaceRegistry 既无 unarchiveSession 也无内部回退入口（DSH 版本不兼容，无法清理归档条目）')
  }
  await registry.enqueueOperation(async () => {
    const state = registry.requireState()
    if (!Array.isArray(state.archivedSessionIds) || !state.archivedSessionIds.includes(id)) return
    await registry.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((member) => member !== id),
    })
  })
}

// ── live 会话运行时卸载（0.5.0）──────────────────────────────────────────
//
// 平台事实（读宿主源码 dsh-agent-loop / dsh-session / dsh-agent /
// dsh-session-persistence-jsonl 构建产物实证）：宿主没有公开的 per-agent
// 卸载 API——AgentHandle 的 dispose 能力被 session-controller 丢弃
// （(await agents.resume(...)).agent 只取 agent），FactoryOwnership.liveAgents
// 是无主 Set 无法按 id 定位。但官方 teardown（agent-loop prepare() 内的
// teardown 闭包）的步骤全部由插件可组合：
//   ① agent.status === 'running' → 拒删（先停止；归档的 stopActivity 已停）；
//   ② agent.cancel({ kind:'disposed' })：取消残余活动（已确认 idle，容错）；
//   ③ agent.scope.dispose()：拆除机器自身的订阅（缺席则留作惰性残留，容错
//      ——session 摘除后不再有事件流入，残留仅是等待 GC 的对象）；
//   ④ 持久化写句柄 close()——官方公开幂等 API（closing ??=）：drain 未落盘
//      缓冲 → 释放跨进程写锁 → releaseHandle 顺带清 pending 条目。Windows
//      下不关句柄文件锁在、磁盘删除必败，因此本步失败即整根拒删；
//   ⑤ agents 注册表条目 detach()（emit agent/disposed，幂等守卫）；
//   ⑥ sessions store 条目 detach()（emit session/disposed，客户端与
//      sessionQuery 据此即时收敛，幂等守卫）。
// 内部可达点（sessions.store / agents.store / sessionPersistence.tracker
// .writers）全部逐 hop feature-detect；任一缺失 → capability=false，整体
// 退回「live 拒删 + 提示重启」旧语义（fail-safe，绝不半套卸载）。

/** live 成员仍在运行（status === 'running'）时由 teardownLiveMember 抛出。 */
export class LiveMemberBusyError extends Error {
  /**
   * @param {string} id - 正在运行的会话 id。
   */
  constructor(id) {
    super(`会话 ${id} 正在运行，停止后再删`)
    this.name = 'LiveMemberBusyError'
  }
}

/**
 * 探测 live 卸载所需的内部可达点。纯同步、零副作用，可随每次请求现测。
 * @param {object} wctx - 宿主上下文（webServer inject 回调的 webCtx）。
 * @returns {{capable: boolean, missing: string[], agents?: object, agentsStore?: Map, sessionsStore?: Map, trackerWriters?: Map}} 探测结果。
 */
export function detectLiveTeardown(wctx) {
  const missing = []
  const service = (key) => {
    try { return wctx.get(key) } catch { return undefined }
  }
  const sessions = service('sessions')
  const agents = service('agents')
  const persistence = service('sessionPersistence')
  const sessionsStore = sessions?.store instanceof Map ? sessions.store : undefined
  if (sessionsStore === undefined) missing.push('sessions.store')
  const agentsStore = agents?.store instanceof Map ? agents.store : undefined
  if (agentsStore === undefined) missing.push('agents.store')
  const trackerWriters = persistence?.tracker?.writers instanceof Map
    ? persistence.tracker.writers
    : undefined
  if (trackerWriters === undefined) missing.push('sessionPersistence.tracker.writers')
  return { capable: missing.length === 0, missing, agents, agentsStore, sessionsStore, trackerWriters }
}

/**
 * 按官方 teardown 同款步骤卸载一个 live-idle 会话成员的全部内存态。
 * 步骤 ④（写句柄 close）失败会抛错——调用方应把该根整体拒删（磁盘不动）。
 * 各步幂等或容错：status 竞态变为 running 抛 {@link LiveMemberBusyError}；
 * cancel/scope 容错跳过；句柄可能缺席（未物化会话无写句柄）；注册表/store
 * 条目可能已被并发摘除（detach 幂等守卫在官方侧）。
 * @param {string} id - 要卸载的会话 id。
 * @param {ReturnType<typeof detectLiveTeardown>} teardown - 能力探测结果。
 * @returns {Promise<{agent: boolean, writeHandle: boolean}>} 实际卸载到哪些内存态。
 */
export async function teardownLiveMember(id, teardown) {
  const agent = typeof teardown.agents?.get === 'function' ? teardown.agents.get(id) : undefined
  if (agent !== undefined && String(agent.status ?? 'idle') === 'running') {
    throw new LiveMemberBusyError(id)
  }
  // ② 取消残余活动（已确认 idle：失败不影响正确性）。
  try {
    if (typeof agent?.cancel === 'function') agent.cancel({ kind: 'disposed' })
  } catch { /* idle 机器的 cancel 失败不影响 */ }
  // ③ 拆除机器自身订阅（scope 缺席/失败 → 惰性残留，见上）。
  try {
    const scope = agent?.scope
    const dispose = scope?.dispose ?? scope?.rawDispose
    if (typeof dispose === 'function') await dispose.call(scope)
  } catch { /* 惰性残留 */ }
  // ④ 关持久化写句柄（必须成功：锁不释放则磁盘删除必败）。
  const handle = teardown.trackerWriters.get(id)
  if (handle != null && typeof handle.close === 'function') await handle.close()
  // ⑤ agents 注册表摘除（emit agent/disposed）。
  const agentEntry = teardown.agentsStore.get(id)
  if (agentEntry !== undefined && typeof agentEntry.detach === 'function') agentEntry.detach()
  // ⑥ sessions store 摘除（emit session/disposed → 客户端/sessionQuery 收敛）。
  const sessionEntry = teardown.sessionsStore.get(id)
  if (sessionEntry !== undefined && typeof sessionEntry.detach === 'function') sessionEntry.detach()
  return { agent: agent !== undefined, writeHandle: handle != null }
}

// ── 附件引用收集 ──────────────────────────────────────────────────────────
//
// 附件 id 形如 sha256:<64 位小写十六进制>（宿主 attachment-local 的
// ID_PATTERN）。引用散布在多种事件的 content 块里（user/message、
// tool/result、agent/inbox/spliced、compaction/summary、assistant 流块……），
// 与其逐形状复刻官方 imageInEvent（漏一种就误删共享对象），这里对事件对象
// 做全量序列化扫描：字符串里出现的合法附件 id 一网打尽。收集与独占检查用
// 同一扫描器，天然对称——收集不到的 id 只会让对应附件被保留（安全方向）。

const ATTACHMENT_ID_PATTERN = /sha256:[a-f0-9]{64}/g

/**
 * 从一批会话事件中收集全部附件 id（sha256 内容寻址）。
 * @param {Iterable<object>} events - 会话事件（任意形状）。
 * @returns {Set<string>} 附件 id 集合。
 */
export function collectAttachmentIds(events) {
  const found = new Set()
  if (events === undefined || events === null) return found
  for (const event of events) {
    let text
    try {
      text = JSON.stringify(event)
    } catch {
      continue // 不可序列化成员（循环引用等）：跳过该事件（附件保留，安全方向）
    }
    if (typeof text !== 'string') continue
    for (const match of text.matchAll(ATTACHMENT_ID_PATTERN)) found.add(match[0])
  }
  return found
}

// ── spill 暂存定位 ────────────────────────────────────────────────────────
//
// 宿主 spill-local 的 sessionDir：join(root, `session-${sha256(sessionId)
// .digest('hex').slice(0, 12)}`)。目录名由会话 id 确定性推导，默认根在
// os.tmpdir() 下的 dsh-spill-<随机> 私有目录（每进程一个）。官方保留名
// session-backup 不匹配 12 位十六进制后缀，永不触及。

/** 宿主 DEFAULT_ROOT_PREFIX 同款前缀。 */
const SPILL_ROOT_PREFIX = 'dsh-spill-'

/**
 * 一个会话 id 对应的 spill 目录名（宿主 sessionDir 同款公式）。
 * @param {string} id - 会话 id。
 * @returns {string} `session-<sha256(id) 前 12 位十六进制>`。
 */
export function spillDirName(id) {
  return `session-${createHash('sha256').update(String(id)).digest('hex').slice(0, 12)}`
}

/**
 * 枚举 os.tmpdir() 下全部 spill 根目录（dsh-spill-* 前缀）。
 * @param {string} [tmpPath] - 临时目录（测试注入用），缺省 os.tmpdir()。
 * @returns {Promise<string[]>} 根目录绝对路径列表。
 */
export async function discoverSpillRoots(tmpPath = tmpdir()) {
  const entries = await readdir(tmpPath, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return []
  const roots = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith(SPILL_ROOT_PREFIX)) continue
    roots.push(join(tmpPath, entry.name))
  }
  return roots
}

// ── 附件对象布局 ──────────────────────────────────────────────────────────
//
// 宿主 LocalAttachmentStore：root = <DSH_HOME>/attachments/v1，
// 图片对象 objects/<2>/<sha>，文件对象 file-objects/<2>/<sha>，
// 带名别名 files/<2>/<sha>/<name>（目录），暂存 tmp/（官方自管，不动）。
// request-images 派生变体缓存在 <DSH_HOME>/cache/attachments/request-images
// 与 root/request-images，按变体散列寻址、无法映射回源附件——凡有附件被
// 删除即整体清空（纯派生缓存，按需重建）。

/**
 * 一个附件 id（sha256:<hex>）在附件根下的全部候选路径。
 * @param {string} attachmentsRoot - 附件存储根（…/attachments/v1）。
 * @param {string} attachmentId - 形如 sha256:<64 hex> 的附件 id。
 * @returns {string[]} 候选绝对路径（图片对象 / 文件对象 / 带名别名目录）。
 */
export function attachmentCandidatePaths(attachmentsRoot, attachmentId) {
  const hex = String(attachmentId).slice(7)
  const prefix = hex.slice(0, 2)
  return [
    join(attachmentsRoot, 'objects', prefix, hex),
    join(attachmentsRoot, 'file-objects', prefix, hex),
    join(attachmentsRoot, 'files', prefix, hex),
  ]
}

/**
 * 删除一个会话 id 在全部 spill 根下的暂存目录。
 * @param {string[]} roots - spill 根目录列表。
 * @param {string} id - 会话 id。
 * @returns {Promise<boolean>} 是否删除了至少一个目录。
 */
export async function removeSpillDirs(roots, id) {
  const name = spillDirName(id)
  let removed = false
  for (const root of roots) {
    const dir = join(root, name)
    const info = await stat(dir).catch(() => undefined)
    if (info === undefined || !info.isDirectory()) continue
    await rm(dir, { recursive: true, force: true })
    removed = true
  }
  return removed
}

/**
 * 删除会话目录后清理其（可能已空的）项目目录。rmdir 仅在目录为空时成功，
 * 非空/被占用在此抛错并静默保留。
 * @param {string[]} projectDirs - 项目目录绝对路径。
 * @returns {Promise<string[]>} 成功移除的项目目录。
 */
export async function pruneEmptyProjectDirs(projectDirs) {
  const pruned = []
  for (const dir of projectDirs) {
    try {
      await rmdir(dir)
      pruned.push(dir)
    } catch {
      /* 非空或不可删：保留 */
    }
  }
  return pruned
}

/**
 * 查询一组已归档会话的可删状态（页面预标注用）。
 * @param {string[]} ids - 已归档会话 id。
 * @param {object} deps - 见 apply 内 routeDeps。
 * @returns {Promise<Object<string, object>>} id -> 状态（busy：子树内有
 *   running 成员；liveIdle：子树内 live 且空闲的成员数——运行时卸载可用时
 *   这类行可直接删除；blockedLive = busy || (liveIdle>0 且卸载不可用)，
 *   兼容旧客户端的「禁选」语义）。
 */
export async function statusOf(ids, deps) {
  const archived = new Set(deps.archivedIds())
  const live = new Set(deps.liveIds())
  const childrenOf = buildChildrenMap(await deps.headers())
  const liveSupported = deps.deleteLiveSessions !== false && deps.liveTeardownCapable === true
    && typeof deps.teardownLive === 'function'
  const agentStatusOf = (id) => (typeof deps.agentStatus === 'function' ? deps.agentStatus(id) : undefined)
  const results = {}
  for (const id of ids) {
    if (!archived.has(id)) {
      results[id] = { archived: false }
      continue
    }
    const subtree = subtreeOf(id, childrenOf)
    let liveCount = 0
    let busyCount = 0
    for (const member of subtree) {
      if (!live.has(member)) continue
      liveCount += 1
      if (agentStatusOf(member) === 'running') busyCount += 1
    }
    const liveIdle = liveCount - busyCount
    results[id] = {
      archived: true,
      blockedLive: busyCount > 0 || (liveIdle > 0 && !liveSupported),
      busy: busyCount > 0,
      liveIdle,
      liveCount,
      subtreeSize: subtree.size,
      hasLog: (await findSessionDirs(deps.sessionsRoot, id)).length > 0,
      hasCache: typeof deps.cacheHas === 'function' ? deps.cacheHas(id) : undefined,
      workspaceRefs: typeof deps.workspaceRefCount === 'function' ? deps.workspaceRefCount(id) : undefined,
      hasSpill: typeof deps.spillHas === 'function' ? await deps.spillHas(id) : undefined,
    }
  }
  return results
}

/**
 * 执行一次批量删除。逐根处理：非归档 id 拒绝；子树成员三分区——running
 * 的整棵子树拒绝（先停止）；live 且空闲的成员（运行时卸载可用时）在
 * 【收集附件引用（live 内存快照优先于冷读）之后、删除日志之前】按官方
 * teardown 同款步骤卸载内存态，任一成员卸载失败 → 该根整体拒删、磁盘
 * 不动；卸载不可用（内部可达点缺失或 deleteLiveSessions:false）时 live
 * 子树退回「重启后可删」旧语义。随后删除子树全部成员的日志目录（磁盘
 * 已缺的成员记为 missing，幂等重跑收敛）并顺手清空项目目录，再依次清
 * 投影缓存、工作台记账、归档条目、spill 暂存，最后对收集到的附件做独
 * 占检查并删除独占对象。日志删除与归档条目清理失败维持 error 语义，
 * 其余辅助清理失败仅记 warnings。单根失败只中断该根，不影响其余。
 * @param {object} options - { ids: 已归档会话根 id 列表 }。
 * @param {object} deps - 见 apply 内 routeDeps。
 * @returns {Promise<{results: Array<{id: string, status: string, message?: string, removed?: string[], missing?: string[], tornDown?: string[], cachePruned?: string[], detachedWorkspaces?: number, spillRemoved?: string[], attachmentsRemoved?: string[], attachmentsKeptShared?: string[], warnings?: string[]}>}>}
 */
export async function performCleanup(options, deps) {
  const archived = new Set(deps.archivedIds())
  const live = new Set(deps.liveIds())
  const childrenOf = buildChildrenMap(await deps.headers())
  const purgeAttachments = deps.purgeAttachments !== false
  const liveSupported = deps.deleteLiveSessions !== false && deps.liveTeardownCapable === true
    && typeof deps.teardownLive === 'function'
  const agentStatusOf = (id) => (typeof deps.agentStatus === 'function' ? deps.agentStatus(id) : undefined)
  const results = []
  // 已在本轮处理过的成员（父根已连带删除/跳过），后续根据此去重。
  const handled = new Set()
  for (const id of options.ids) {
    if (!archived.has(id)) {
      results.push({ id, status: 'not-archived' })
      continue
    }
    if (handled.has(id)) {
      results.push({ id, status: 'deleted', message: '已随所选父会话一并删除' })
      continue
    }
    const subtree = subtreeOf(id, childrenOf)
    const busyMembers = []
    const liveIdleMembers = []
    for (const member of subtree) {
      if (!live.has(member)) continue
      if (agentStatusOf(member) === 'running') busyMembers.push(member)
      else liveIdleMembers.push(member)
    }
    if (busyMembers.length > 0) {
      results.push({
        id,
        status: 'busy',
        message: `该会话${busyMembers.length > 1 ? '及其子会话中' : '或其子会话中'}有 ${busyMembers.length} 个正在运行，停止后即可删除`,
      })
      continue
    }
    if (liveIdleMembers.length > 0 && !liveSupported) {
      results.push({
        id,
        status: 'live',
        message: `该会话${liveIdleMembers.length > 1 ? '及其子会话中' : '或其子会话中'}有 ${liveIdleMembers.length} 个仍在使用，且当前 DSH 缺少运行时卸载入口，重启 DSH 后可删`,
      })
      continue
    }
    // 【删除前】收集子树成员日志中的附件引用（读不出的成员跳过——其附件
    // 不在收集集内，最终被保留，安全方向）。live 成员优先用内存快照（含
    // 未落盘缓冲，比冷读更准）；冷成员走公开读路径。目录已缺（missing
    // 重跑）的成员无从读取，同样跳过。
    const subtreeRefs = new Set()
    const warnings = []
    if (purgeAttachments) {
      for (const member of subtree) {
        if (handled.has(member)) continue
        const liveMember = liveIdleMembers.includes(member)
        if (liveMember && typeof deps.liveSnapshotEvents === 'function') {
          const snapshot = deps.liveSnapshotEvents(member)
          if (snapshot !== undefined) {
            for (const ref of collectAttachmentIds(snapshot)) subtreeRefs.add(ref)
            continue
          }
        }
        if (!liveMember && (await findSessionDirs(deps.sessionsRoot, member)).length === 0) continue
        if (typeof deps.readEvents !== 'function') continue
        let events
        try {
          events = await deps.readEvents(member)
        } catch (error) {
          warnings.push(`读取会话 ${member} 的日志以收集附件引用失败（对应附件将保留）：${error?.message ?? String(error)}`)
          continue
        }
        if (events !== undefined) {
          for (const ref of collectAttachmentIds(events)) subtreeRefs.add(ref)
        }
      }
    }
    // 【删除前】卸载 live-idle 成员的内存态（官方 teardown 同款步骤）。任一
    // 成员失败（含竞态变为 running）→ 该根整体拒删、磁盘不动：绝不出现
    // 「内存卸了一半、写句柄未关」之后继续删盘的中间态。已卸载的成员转为
    // 冷数据，重跑按冷路径收敛。
    const tornDown = []
    if (liveIdleMembers.length > 0) {
      let teardownFailure
      for (const member of liveIdleMembers) {
        try {
          await deps.teardownLive(member)
          tornDown.push(member)
        } catch (error) {
          teardownFailure = teardownFailure ?? { member, error }
        }
      }
      if (teardownFailure !== undefined) {
        results.push({
          id,
          status: 'error',
          message: `卸载会话 ${teardownFailure.member} 的内存态失败：${teardownFailure.error?.message ?? String(teardownFailure.error)}`,
          tornDown,
        })
        continue
      }
    }
    const removed = []
    const missing = []
    const projectDirs = new Set()
    let failure
    for (const member of subtree) {
      if (handled.has(member)) continue
      let dirs
      try {
        dirs = await findSessionDirs(deps.sessionsRoot, member)
      } catch (error) {
        failure = { member, error }
        break
      }
      try {
        if (dirs.length === 0) {
          missing.push(member)
        } else {
          for (const dir of dirs) {
            await rm(dir, { recursive: true, force: true })
            projectDirs.add(dirname(dir))
          }
          removed.push(member)
        }
        handled.add(member)
      } catch (error) {
        failure = { member, error }
        break
      }
    }
    if (failure !== undefined) {
      results.push({
        id,
        status: 'error',
        message: `删除会话 ${failure.member} 的日志失败：${failure.error?.message ?? String(failure.error)}`,
      })
      continue
    }
    // 日志已删：项目目录若已空则顺手移除（非空/被占用则静默保留）。
    if (projectDirs.size > 0) await pruneEmptyProjectDirs([...projectDirs])
    // 投影缓存：官方服务已打开的 session_projcache 域，table.delete 幂等。
    const cachePruned = []
    if (typeof deps.pruneCache === 'function') {
      for (const member of subtree) {
        try {
          if (await deps.pruneCache(member)) cachePruned.push(member)
        } catch (error) {
          warnings.push(`清理会话 ${member} 的投影缓存失败：${error?.message ?? String(error)}`)
        }
      }
    }
    // 工作台记账：对每个工作台调官方 detachSession（幂等 no-op）。
    let detachedWorkspaces = 0
    if (typeof deps.detachFromWorkspaces === 'function') {
      for (const member of subtree) {
        try {
          detachedWorkspaces += await deps.detachFromWorkspaces(member)
        } catch (error) {
          warnings.push(`清理会话 ${member} 的工作台记账失败：${error?.message ?? String(error)}`)
        }
      }
    }
    // spill 暂存目录。
    const spillRemoved = []
    if (typeof deps.removeSpill === 'function') {
      for (const member of subtree) {
        try {
          if (await deps.removeSpill(member)) spillRemoved.push(member)
        } catch (error) {
          warnings.push(`清理会话 ${member} 的临时暂存文件失败：${error?.message ?? String(error)}`)
        }
      }
    }
    // 归档条目（保持既有 error 语义：文件已删但条目清理失败要显式暴露）。
    let pruneError
    for (const member of subtree) {
      if (!archived.has(member)) continue
      try {
        await deps.unarchive(member)
      } catch (error) {
        pruneError = pruneError ?? `文件已删除，但清理归档条目 ${member} 失败：${error?.message ?? String(error)}`
      }
    }
    if (pruneError !== undefined) {
      results.push({
        id,
        status: 'error',
        removed,
        missing,
        tornDown,
        cachePruned,
        detachedWorkspaces,
        spillRemoved,
        warnings,
        message: pruneError,
      })
      continue
    }
    // 附件 GC：日志已删，扫描幸存会话的引用，仅删独占对象。
    const attachmentsRemoved = []
    const attachmentsKeptShared = []
    if (purgeAttachments && subtreeRefs.size > 0 && typeof deps.removeAttachment === 'function') {
      try {
        const elsewhere = typeof deps.scanElsewhere === 'function'
          ? await deps.scanElsewhere(subtreeRefs)
          : new Set()
        for (const ref of subtreeRefs) {
          if (elsewhere.has(ref)) {
            attachmentsKeptShared.push(ref)
            continue
          }
          if (await deps.removeAttachment(ref)) attachmentsRemoved.push(ref)
        }
        if (attachmentsRemoved.length > 0 && typeof deps.flushRequestImageCaches === 'function') {
          await deps.flushRequestImageCaches()
        }
      } catch (error) {
        warnings.push(`附件清理失败（全部附件已保留）：${error?.message ?? String(error)}`)
      }
    }
    results.push({
      id,
      status: 'deleted',
      removed,
      missing,
      tornDown,
      cachePruned,
      detachedWorkspaces,
      spillRemoved,
      attachmentsRemoved,
      attachmentsKeptShared,
      warnings,
    })
  }
  return { results }
}

/**
 * 一次孤儿清扫：修复历史删除（或本插件旧版本）留下的本地残留。全部操作
 * 幂等、只针对「既无日志目录又非 live」的悬空数据，不触碰任何幸存会话。
 * @param {object} deps - 见 apply 内 routeDeps。
 * @returns {Promise<{results: {cachePruned: string[], workspacesDetached: Array<{id: string, count: number}>, deadArchivedPruned: string[], spillRemoved: string[], emptyProjectDirs: string[]}, warnings: string[]}>}
 */
export async function performSweep(deps) {
  const live = new Set(deps.liveIds())
  const warnings = []
  const hasLog = async (id) => (await findSessionDirs(deps.sessionsRoot, id).catch(() => [])).length > 0

  // 1. 投影缓存孤儿：缓存里有、磁盘与 live 都没有。
  const cachePruned = []
  if (typeof deps.cacheIds === 'function' && typeof deps.pruneCache === 'function') {
    for (const id of deps.cacheIds()) {
      if (live.has(id) || (await hasLog(id))) continue
      try {
        if (await deps.pruneCache(id)) cachePruned.push(id)
      } catch (error) {
        warnings.push(`清理孤儿投影缓存 ${id} 失败：${error?.message ?? String(error)}`)
      }
    }
  }

  // 2. 工作台记账孤儿：raw sessionIds 里有、磁盘与 live 都没有。
  const workspacesDetached = []
  if (typeof deps.accountedIds === 'function' && typeof deps.detachFromWorkspaces === 'function') {
    for (const id of deps.accountedIds()) {
      if (live.has(id) || (await hasLog(id))) continue
      try {
        const count = await deps.detachFromWorkspaces(id)
        if (count > 0) workspacesDetached.push({ id, count })
      } catch (error) {
        warnings.push(`清理会话 ${id} 的工作台记账失败：${error?.message ?? String(error)}`)
      }
    }
  }

  // 3. 归档集死条目：归档集中有、磁盘与 live 都没有（与页面死条目删除同路径）。
  const deadArchivedPruned = []
  for (const id of deps.archivedIds()) {
    if (live.has(id) || (await hasLog(id))) continue
    try {
      await deps.unarchive(id)
      deadArchivedPruned.push(id)
    } catch (error) {
      warnings.push(`清理死归档条目 ${id} 失败：${error?.message ?? String(error)}`)
    }
  }

  // 3.5 垃圾 id 的 spill 暂存目录：目录名由 id 确定性推导，上面三步找出的
  // 每个垃圾 id 都顺带回收其 session-<hash12> 目录（hash 不可逆，只有这些
  // 已知垃圾 id 能定位；完全无从索引的遗留 spill 目录仍由官方 30 天保留期
  // 的启动清扫兜底）。
  const spillRemoved = []
  if (typeof deps.removeSpill === 'function') {
    const garbageIds = [...cachePruned, ...workspacesDetached.map((entry) => entry.id), ...deadArchivedPruned]
    for (const id of garbageIds) {
      try {
        if (await deps.removeSpill(id)) spillRemoved.push(id)
      } catch (error) {
        warnings.push(`清理会话 ${id} 的临时暂存文件失败：${error?.message ?? String(error)}`)
      }
    }
  }

  // 4. 空项目目录：sessions 根下已不含任何会话目录的项目目录。
  const emptyProjectDirs = []
  const projects = await readdir(deps.sessionsRoot, { withFileTypes: true }).catch(() => undefined)
  if (projects !== undefined) {
    for (const entry of projects) {
      if (!entry.isDirectory()) continue
      const dir = join(deps.sessionsRoot, entry.name)
      try {
        await rmdir(dir) // 仅空目录可删：非空/被占用在此抛错并跳过
        emptyProjectDirs.push(dir)
      } catch {
        /* 非空或不可删：保留 */
      }
    }
  }

  return { results: { cachePruned, workspacesDetached, deadArchivedPruned, spillRemoved, emptyProjectDirs }, warnings }
}

/** 读一个请求体并解析 JSON（上限 1 MiB）。 */
function readJsonBody(req, limit = 1 << 20) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        rejectBody(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        rejectBody(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', rejectBody)
  })
}

/** 校验请求体里的 ids：字符串数组、去重、上限 500。 */
function parseIds(payload) {
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.ids)) {
    throw new Error('request body must be { "ids": string[] }')
  }
  const ids = []
  const seen = new Set()
  for (const item of payload.ids) {
    if (typeof item !== 'string' || item === '') continue
    if (seen.has(item)) continue
    seen.add(item)
    ids.push(item)
    if (ids.length > 500) throw new Error('too many ids in one request (max 500)')
  }
  return ids
}

export function apply(ctx, config = {}) {
  const dshHome = dshHomeOf()
  const sessionsRoot = typeof config.sessionsRoot === 'string' && config.sessionsRoot !== ''
    ? resolve(config.sessionsRoot)
    : join(dshHome, 'sessions')
  const attachmentsRoot = typeof config.attachmentsRoot === 'string' && config.attachmentsRoot !== ''
    ? resolve(config.attachmentsRoot)
    : join(dshHome, 'attachments', 'v1')
  const extraSpillRoots = Array.isArray(config.spillRoots)
    ? config.spillRoots.filter((item) => typeof item === 'string' && item !== '').map((item) => resolve(item))
    : []
  const requestImageCacheDirs = [
    join(dshHome, 'cache', 'attachments', 'request-images'),
    join(attachmentsRoot, 'request-images'),
  ]
  const purgeAttachments = config.purgeAttachments !== false
  const deleteLiveSessions = config.deleteLiveSessions !== false

  // ── 服务访问辅助（apply 作用域，routeDeps 之外以便复用）─────────────────

  /** 官方 sessionProjectionCache 已打开的 session_projcache 域表句柄（可能缺席）。 */
  const cacheTableOf = (wctx) => {
    try {
      const storageDomain = wctx.get('storageDomain')
      const domain = typeof storageDomain?.get === 'function' ? storageDomain.get('session_projcache') : undefined
      return domain !== undefined && typeof domain.table === 'function'
        ? domain.table('sessions')
        : undefined
    } catch {
      return undefined
    }
  }

  /** registry.list() 实体的 raw record sessionIds（实体 getter 会被 header 索引过滤，raw 才完整）。 */
  const workspaceRawRecords = (wctx) => {
    const records = []
    try {
      const registry = wctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.list !== 'function') return records
      for (const workspace of registry.list()) {
        const raw = Array.isArray(workspace?.record?.sessionIds)
          ? workspace.record.sessionIds.map(String)
          : Array.isArray(workspace?.sessionIds) ? [...workspace.sessionIds].map(String) : []
        records.push({ entity: workspace, sessionIds: raw })
      }
    } catch {
      /* 服务缺席：无记账可清 */
    }
    return records
  }

  /** 全部 spill 根：配置的 spillRoots + os.tmpdir() 下发现的 dsh-spill-*。 */
  const spillRootsOf = async () => {
    const roots = new Set(extraSpillRoots)
    for (const root of await discoverSpillRoots()) roots.add(root)
    return [...roots]
  }

  /** 读一个冷会话的完整事件（官方 persistence 公开读路径；任何失败返回 undefined）。 */
  const readEventsOf = async (wctx, id) => {
    try {
      const persistence = wctx.get('sessionPersistence')
      if (persistence === undefined
        || typeof persistence.resolveCurrentLog !== 'function'
        || typeof persistence.readStoredLog !== 'function') return undefined
      const path = await persistence.resolveCurrentLog(id)
      if (path === undefined) return undefined
      const log = await persistence.readStoredLog(path, id)
      return log?.events
    } catch {
      return undefined
    }
  }

  // 请求时现读各服务（保证最新状态；服务缺席时安全降级）。live 卸载能力
  // 同样每请求现测（detectLiveTeardown 纯同步零副作用）。
  const routeDeps = (wctx) => {
    const liveTeardown = detectLiveTeardown(wctx)
    return {
    sessionsRoot,
    purgeAttachments,
    deleteLiveSessions,
    liveTeardownCapable: liveTeardown.capable,
    liveTeardownMissing: liveTeardown.missing,
    agentStatus: (id) => {
      try {
        const agents = wctx.get('agents')
        const agent = typeof agents?.get === 'function' ? agents.get(id) : undefined
        return agent === undefined ? undefined : String(agent.status ?? 'idle')
      } catch {
        return undefined
      }
    },
    liveSnapshotEvents: (id) => {
      try {
        const sessions = wctx.get('sessions')
        const session = typeof sessions?.get === 'function' ? sessions.get(id) : undefined
        return session !== undefined && typeof session.snapshotEvents === 'function'
          ? session.snapshotEvents()
          : undefined
      } catch {
        return undefined
      }
    },
    teardownLive: (id) => teardownLiveMember(id, liveTeardown),
    archivedIds: () => {
      try {
        const registry = wctx.get('workspaceRegistry')
        const archived = registry?.archivedSessionIds
        return Array.isArray(archived) ? archived.map(String) : []
      } catch {
        return []
      }
    },
    liveIds: () => {
      try {
        const sessions = wctx.get('sessions')
        return sessions !== undefined ? sessions.list().map((session) => String(session.id)) : []
      } catch {
        return []
      }
    },
    headers: async () => {
      const out = []
      try {
        const sessions = wctx.get('sessions')
        if (sessions !== undefined) {
          for (const session of sessions.list()) {
            out.push({
              id: String(session.id),
              ...(session.header?.parentSession !== undefined
                ? { parentSessionId: String(session.header.parentSession) }
                : {}),
            })
          }
        }
      } catch {
        /* live 侧读取失败退化为持久化侧 */
      }
      try {
        const persistence = wctx.get('sessionPersistence')
        if (persistence !== undefined) {
          for (const snapshot of await persistence.list()) {
            out.push({
              id: String(snapshot.header.id),
              ...(snapshot.header.parentSession !== undefined
                ? { parentSessionId: String(snapshot.header.parentSession) }
                : {}),
            })
          }
        }
      } catch {
        /* 持久化侧读取失败退化为 live 侧（后代探测不全，删除仍安全） */
      }
      return out
    },
    unarchive: (id) => unarchiveRegistryEntry(wctx.get('workspaceRegistry'), id),

    // ── 0.2.0 新增依赖：缓存 / 记账 / spill / 附件 ──────────────────────

    readEvents: (id) => readEventsOf(wctx, id),
    cacheIds: () => {
      const table = cacheTableOf(wctx)
      try {
        return table !== undefined ? [...table.keys()].map(String) : []
      } catch {
        return []
      }
    },
    cacheHas: (id) => {
      const table = cacheTableOf(wctx)
      try {
        return table !== undefined && table.get(id) !== undefined
      } catch {
        return false
      }
    },
    pruneCache: async (id) => {
      const table = cacheTableOf(wctx)
      if (table === undefined || typeof table.delete !== 'function') return false
      return await table.delete(id)
    },
    accountedIds: () => {
      const out = new Set()
      for (const record of workspaceRawRecords(wctx)) {
        for (const id of record.sessionIds) out.add(id)
      }
      return [...out]
    },
    workspaceRefCount: (id) => {
      let count = 0
      for (const record of workspaceRawRecords(wctx)) {
        if (record.sessionIds.includes(id)) count += 1
      }
      return count
    },
    /** 对每个工作台调官方 detachSession；返回实际含有该 id 的工作台数。 */
    detachFromWorkspaces: async (id) => {
      const registry = wctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.list !== 'function') return 0
      const raws = new Map()
      for (const record of workspaceRawRecords(wctx)) raws.set(record.entity, record.sessionIds)
      let detached = 0
      for (const workspace of registry.list()) {
        if (typeof workspace.detachSession !== 'function') continue
        const had = (raws.get(workspace) ?? []).includes(id)
        await workspace.detachSession(id)
        if (had) detached += 1
      }
      return detached
    },
    spillHas: async (id) => {
      const name = spillDirName(id)
      for (const root of await spillRootsOf()) {
        const info = await stat(join(root, name)).catch(() => undefined)
        if (info !== undefined && info.isDirectory()) return true
      }
      return false
    },
    removeSpill: async (id) => removeSpillDirs(await spillRootsOf(), id),
    /**
     * 独占检查：扫描全部幸存持久化会话的日志，返回候选集中仍被引用的 id。
     * 此时被删子树的日志目录已移除，persistence.list() 只含幸存会话；
     * 本进程新建未落盘的会话（事件未持久化）不在扫描内——其附件刚上传，
     * 与被删归档子树共享同一对象的概率可忽略，且误删后读失败是响亮的。
     */
    scanElsewhere: async (candidateIds) => {
      const persistence = wctx.get('sessionPersistence')
      if (persistence === undefined || typeof persistence.list !== 'function') {
        throw new Error('sessionPersistence 服务不可用，无法核对附件引用（附件保留）')
      }
      const found = new Set()
      for (const snapshot of await persistence.list()) {
        const events = await readEventsOf(wctx, String(snapshot.header.id))
        if (events === undefined) continue
        for (const ref of collectAttachmentIds(events)) {
          if (candidateIds.has(ref)) found.add(ref)
        }
      }
      return found
    },
    /** 删除一个附件 id 的全部对象布局（图片对象/文件对象/带名别名目录）。 */
    removeAttachment: async (attachmentId) => {
      let removed = false
      for (const path of attachmentCandidatePaths(attachmentsRoot, attachmentId)) {
        const info = await stat(path).catch(() => undefined)
        if (info === undefined) continue
        await rm(path, { recursive: true, force: true })
        removed = true
      }
      return removed
    },
    flushRequestImageCaches: async () => {
      for (const dir of requestImageCacheDirs) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
    },
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    const lanDeployment = webCtx.webServer?.host === '0.0.0.0'
    const register = (path, action) =>
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: 'exact',
            path,
            handler: async (req, res) => {
              const send = (status, payload) => {
                res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify(payload))
              }
              try {
                if (req.method !== 'POST') {
                  send(405, { ok: false, error: 'method not allowed' })
                  return
                }
                if (!isTrustedPluginRequest(req, lanDeployment)) {
                  send(403, { ok: false, error: 'untrusted request rejected' })
                  return
                }
                await action(req, send, send)
              } catch (error) {
                send(500, { ok: false, error: String(error?.message ?? error) })
              }
            },
          }),
        `dsh-archived-cleanup: ${path} route`,
      )

    register('/plugins/dsh-archived-cleanup/status', async (req, send) => {
      const ids = parseIds(await readJsonBody(req))
      const deps = routeDeps(webCtx)
      send(200, {
        ok: true,
        liveTeardown: { capable: deps.liveTeardownCapable, missing: deps.liveTeardownMissing },
        results: await statusOf(ids, deps),
      })
    })

    register('/plugins/dsh-archived-cleanup/delete', async (req, send) => {
      const ids = parseIds(await readJsonBody(req))
      const registry = webCtx.get('workspaceRegistry')
      if (registry === undefined) {
        send(503, { ok: false, error: 'workspaceRegistry 服务不可用，无法删除' })
        return
      }
      const { results } = await performCleanup({ ids }, routeDeps(webCtx))
      // 删除后总是顺带一次全局孤儿清扫（幂等，只碰既无日志又非 live 的悬空
      // 数据）：单按钮语义下这是唯一入口。清扫失败不拖垮删除结果，降级为
      // sweep.warnings 里的一条错误。
      let sweep
      try {
        const payload = await performSweep(routeDeps(webCtx))
        sweep = { results: payload.results, warnings: payload.warnings }
      } catch (error) {
        sweep = { results: {}, warnings: [`孤儿清扫失败（删除本身已完成）：${error?.message ?? String(error)}`] }
      }
      webCtx.logger?.info?.('dsh-archived-cleanup: delete done (%j) sweep (%j)', results, sweep.results)
      send(200, { ok: true, results, sweep })
    })

    // 0.6.0 维护入口：遗留会话全量清理（保留 live 子树）。破坏性操作必须
    // 携带显式确认串；先逐个官方归档（feed 增量即时收敛），再复用 delete
    // 的全部管线与内联清扫。excluded 如实回传供核对。
    register('/plugins/dsh-archived-cleanup/purge-all', async (req, send) => {
      const body = await readJsonBody(req).catch(() => undefined)
      if (body?.confirm !== 'purge-all-except-live') {
        send(400, { ok: false, error: 'purge-all 需要显式确认：{ "confirm": "purge-all-except-live" }' })
        return
      }
      const registry = webCtx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.archiveSession !== 'function') {
        send(503, { ok: false, error: 'workspaceRegistry 服务不可用（或无 archiveSession），无法全量清理' })
        return
      }
      const deps = routeDeps(webCtx)
      const keepIds = Array.isArray(body.keepIds) ? body.keepIds.map(String) : []
      const plan = await planPurge(deps, keepIds)
      // 逐个官方归档写链（失败只记 warning 跳过，不阻断其余）。
      const warnings = []
      const ids = []
      for (const id of plan.candidates) {
        try {
          await registry.archiveSession(id)
          ids.push(id)
        } catch (error) {
          warnings.push(`归档 ${id} 失败（已跳过，未删除）：${error?.message ?? String(error)}`)
        }
      }
      const { results } = await performCleanup({ ids }, deps)
      let sweep
      try {
        const payload = await performSweep(deps)
        sweep = { results: payload.results, warnings: payload.warnings }
      } catch (error) {
        sweep = { results: {}, warnings: [`孤儿清扫失败（删除本身已完成）：${error?.message ?? String(error)}`] }
      }
      webCtx.logger?.info?.(
        'dsh-archived-cleanup: purge-all done (excluded %j) results (%j)',
        [...plan.excluded], results,
      )
      send(200, {
        ok: true,
        excluded: [...plan.excluded],
        archivedCount: ids.length,
        results,
        sweep,
        warnings,
      })
    })

    register('/plugins/dsh-archived-cleanup/sweep', async (req, send) => {
      const registry = webCtx.get('workspaceRegistry')
      if (registry === undefined) {
        send(503, { ok: false, error: 'workspaceRegistry 服务不可用，无法清扫' })
        return
      }
      const payload = await performSweep(routeDeps(webCtx))
      webCtx.logger?.info?.('dsh-archived-cleanup: sweep done (%j)', payload.results)
      send(200, { ok: true, results: payload.results, warnings: payload.warnings })
    })
  })
}
