// selftest.mjs — dsh-archived-cleanup 纯函数与核心流程自测。
// 运行：node selftest.mjs（零依赖，仅 Node 内置模块 + node:test 风格手写断言）。

import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  apply,
  attachmentCandidatePaths,
  buildChildrenMap,
  collectAttachmentIds,
  detectLiveTeardown,
  discoverSpillRoots,
  dshHomeOf,
  encodeSegment,
  findSessionDirs,
  name,
  performCleanup,
  performSweep,
  planPurge,
  pruneEmptyProjectDirs,
  removeSpillDirs,
  spillDirName,
  statusOf,
  subtreeOf,
  teardownLiveMember,
  unarchiveRegistryEntry,
} from './index.js'

const results = []
const test = (label, fn) => {
  try {
    fn()
    results.push({ label, ok: true })
  } catch (error) {
    results.push({ label, ok: false, error: error?.message ?? String(error) })
  }
}
const testAsync = (label, fn) => fn().then(
  () => { results.push({ label, ok: true }) },
  (error) => { results.push({ label, ok: false, error: error?.message ?? String(error) }) },
)

// ── 元数据 ────────────────────────────────────────────────────────────────
test('exports plugin name', () => {
  assert.equal(name, 'dsh-archived-cleanup')
})
test('apply is a function (mounts routes via ctx.inject)', () => {
  assert.equal(typeof apply, 'function')
})

// ── dshHomeOf ─────────────────────────────────────────────────────────────
test('dshHomeOf honors DSH_HOME env', () => {
  assert.equal(dshHomeOf({ DSH_HOME: 'D:/x' }), 'D:\\x')
})
test('dshHomeOf falls back to ~/.dsh', () => {
  const home = dshHomeOf({})
  assert.ok(home.endsWith(join('.dsh')) || home.endsWith('.dsh'), home)
})

// ── encodeSegment（宿主 format.ts 同款语义）───────────────────────────────
test('encodeSegment keeps safe characters literal', () => {
  assert.equal(encodeSegment('session-555e8d38-956c-400b-b05f-d325e5fd4c84'),
    'session-555e8d38-956c-400b-b05f-d325e5fd4c84')
})
test('encodeSegment escapes ~ and unsafe characters', () => {
  assert.equal(encodeSegment('a~b/c'), 'a~007Eb~002Fc')
})
test('encodeSegment neutralizes traversal segments', () => {
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
})

// ── buildChildrenMap / subtreeOf ─────────────────────────────────────────
test('buildChildrenMap indexes direct children by parent', () => {
  const map = buildChildrenMap([
    { id: 'p' },
    { id: 'c1', parentSessionId: 'p' },
    { id: 'c2', parentSessionId: 'p' },
    { id: 'gc', parentSessionId: 'c1' },
  ])
  assert.deepEqual([...map.get('p')].sort(), ['c1', 'c2'])
  assert.deepEqual(map.get('c1'), ['gc'])
})
test('subtreeOf is the transitive closure including the root', () => {
  const map = buildChildrenMap([
    { id: 'p' },
    { id: 'c1', parentSessionId: 'p' },
    { id: 'gc', parentSessionId: 'c1' },
    { id: 'other' },
  ])
  assert.deepEqual([...subtreeOf('p', map)].sort(), ['c1', 'gc', 'p'])
  assert.deepEqual(subtreeOf('other', map), new Set(['other']))
})

// ── unarchiveRegistryEntry（版本自适应的归档条目清理）────────────────────
/** 仿 0.1.5-rc.2 WorkspaceRegistry 内部写路径的最小 fake（含持久化与幂等语义）。 */
const makeLegacyRegistry = (archivedSessionIds) => {
  const registry = {
    state: { initialized: true, workspaceIds: [], archivedSessionIds },
    writes: 0,
    requireState() { return this.state },
    async setState(next) {
      this.writes += 1
      this.state = next
    },
    enqueueOperation(operation) { return operation() },
  }
  return registry
}

await testAsync('unarchiveRegistryEntry prefers the official unarchiveSession method', async () => {
  const calls = []
  const registry = {
    unarchiveSession: async (id) => { calls.push(id) },
    enqueueOperation: () => { throw new Error('fallback must not run when official method exists') },
  }
  await unarchiveRegistryEntry(registry, 'session-x')
  assert.deepEqual(calls, ['session-x'])
})

await testAsync('unarchiveRegistryEntry filters the archived set via legacy internals', async () => {
  const registry = makeLegacyRegistry(['session-a', 'session-b', 'session-c'])
  await unarchiveRegistryEntry(registry, 'session-b')
  assert.deepEqual(registry.state.archivedSessionIds, ['session-a', 'session-c'])
  assert.equal(registry.state.initialized, true)
  assert.equal(registry.writes, 1)
})

await testAsync('unarchiveRegistryEntry legacy path is idempotent (no write when absent)', async () => {
  const registry = makeLegacyRegistry(['session-a'])
  await unarchiveRegistryEntry(registry, 'session-gone')
  assert.deepEqual(registry.state.archivedSessionIds, ['session-a'])
  assert.equal(registry.writes, 0)
})

await testAsync('unarchiveRegistryEntry rejects when neither official nor fallback exists', async () => {
  await assert.rejects(
    () => unarchiveRegistryEntry({}, 'session-x'),
    /版本不兼容/,
  )
})

await testAsync('unarchiveRegistryEntry rejects when the registry service is missing', async () => {
  await assert.rejects(
    () => unarchiveRegistryEntry(undefined, 'session-x'),
    /服务不可用/,
  )
})

// ── collectAttachmentIds（全量序列化扫描，收集与独占检查对称）──────────────
const ATT_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ATT_B = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const ATT_C = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
const ATT_D = 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'

test('collectAttachmentIds finds image and file refs across event shapes', () => {
  const found = collectAttachmentIds([
    { type: 'user/message', data: { content: [{ type: 'image', attachmentId: ATT_A }, { type: 'text', text: 'hi' }] } },
    { type: 'tool/result', data: { message: { content: [{ type: 'file', file: { attachmentId: ATT_B, name: 'a.txt' } }] } } },
    { type: 'agent/inbox/spliced', data: { inserted: [{ content: [{ type: 'image', attachmentId: ATT_C }] }] } },
    { type: 'assistant/message', data: { stream: [{ block: { type: 'image_url', image_url: { url: `data:x;${ATT_A}` } } }] } },
    { type: 'turn/end', data: { turn: 1 } },
  ])
  assert.deepEqual([...found].sort(), [ATT_A, ATT_B, ATT_C].sort())
})
test('collectAttachmentIds ignores malformed ids and tolerates bad events', () => {
  const circular = { type: 'user/message', data: {} }
  circular.data.self = circular
  const found = collectAttachmentIds([
    { type: 'x', data: { attachmentId: 'sha256:not-a-digest' } },
    { type: 'y', data: { note: `prefix ${ATT_A} suffix` } },
    circular,
  ])
  assert.deepEqual([...found], [ATT_A])
})
test('collectAttachmentIds handles empty input', () => {
  assert.deepEqual([...collectAttachmentIds(undefined)], [])
  assert.deepEqual([...collectAttachmentIds(null)], [])
  assert.deepEqual([...collectAttachmentIds([])], [])
})

// ── spillDirName / discoverSpillRoots / removeSpillDirs ──────────────────
test('spillDirName matches the host sessionDir formula', () => {
  const id = 'session-555e8d38-956c-400b-b05f-d325e5fd4c84'
  const dirName = spillDirName(id)
  assert.match(dirName, /^session-[0-9a-f]{12}$/)
  assert.equal(dirName, spillDirName(id)) // 确定性
  assert.notEqual(dirName, spillDirName('session-other'))
  // 与宿主 spill-local sessionDir 公式独立复算（防回归）：
  assert.equal(dirName, `session-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`)
})

await testAsync('discoverSpillRoots finds only dsh-spill-* directories', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-ac-tmp-'))
  await mkdir(join(base, 'dsh-spill-abc'))
  await mkdir(join(base, 'other-dir'))
  const roots = await discoverSpillRoots(base)
  assert.deepEqual(roots, [join(base, 'dsh-spill-abc')])
  await rm(base, { recursive: true, force: true })
})

await testAsync('removeSpillDirs deletes the derived session dir across roots', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-ac-spill-'))
  const rootA = join(base, 'dsh-spill-aaa')
  const rootB = join(base, 'dsh-spill-bbb')
  const id = 'session-remove-spill'
  const dirA = join(rootA, spillDirName(id))
  const dirB = join(rootB, spillDirName(id))
  const dirOther = join(rootA, spillDirName('session-keep'))
  await mkdir(dirA, { recursive: true })
  await mkdir(dirB, { recursive: true })
  await mkdir(dirOther, { recursive: true })
  await writeFile(join(dirA, '0-tool-results.txt'), 'x')
  assert.equal(await removeSpillDirs([rootA, rootB], id), true)
  assert.deepEqual((await readdir(rootA)).sort(), [spillDirName('session-keep')])
  assert.deepEqual(await readdir(rootB), [])
  assert.equal(await removeSpillDirs([rootA], id), false) // 幂等：目录已缺
  await rm(base, { recursive: true, force: true })
})

// ── attachmentCandidatePaths / pruneEmptyProjectDirs ─────────────────────
test('attachmentCandidatePaths covers images, file objects and named aliases', () => {
  const root = join('D:', 'att', 'v1')
  const paths = attachmentCandidatePaths(root, ATT_B)
  const hex = ATT_B.slice(7)
  const prefix = hex.slice(0, 2)
  assert.deepEqual([...paths].sort(), [
    join(root, 'objects', prefix, hex),
    join(root, 'file-objects', prefix, hex),
    join(root, 'files', prefix, hex),
  ].sort())
})

await testAsync('pruneEmptyProjectDirs removes empty dirs and keeps non-empty ones', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-ac-proj-'))
  const empty = join(base, 'empty-project')
  const full = join(base, 'full-project')
  await mkdir(empty, { recursive: true })
  await mkdir(join(full, 'session-x'), { recursive: true })
  const pruned = await pruneEmptyProjectDirs([empty, full])
  assert.deepEqual(pruned, [empty])
  assert.deepEqual(await readdir(base), ['full-project'])
  await rm(base, { recursive: true, force: true })
})

// ── bundle 补丁的可移植 insert 行（裸包名 + 本地热更技巧注记的回归护栏）──────
await testAsync('cordis.patch.yml inserts a portable bare-package host entry', async () => {
  const text = await readFile(new URL('./cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(text, /-\s+id:\s*archived-cleanup\s*\r?\n\s+name:\s*dsh-archived-cleanup\s*$/m,
    'insert 行必须是可移植的 {id: archived-cleanup, name: dsh-archived-cleanup}（file:/// 绝对路径 + ?t= 属于本机热更的本地覆盖，不随仓库分发）')
  assert.match(text, /file:\/\/\/[^\s]*index\.js\?t=[^\s]*/,
    '注释需保留本地热更技巧说明（file: URL + ?t= 缓存穿透，供 hmr root 为空的部署免重启加载宿主半边）')
})

// ── findSessionDirs + statusOf + performCleanup（临时目录端到端）──────────
const fixture = await mkdtemp(join(tmpdir(), 'dsh-ac-'))
const projectA = join(fixture, '--proj-a--')
await mkdir(join(projectA, 'session-root'), { recursive: true })
await mkdir(join(projectA, 'session-child'), { recursive: true })
// 「死条目」session-dead 刻意不建目录：归档集中存在、磁盘上已无日志。
await writeFile(join(projectA, 'session-root', 'session.v3.jsonl.zstd'), 'x')
await writeFile(join(projectA, 'session-child', 'session.v3.jsonl.zstd'), 'x')

const unarchived = []
const makeDeps = (liveIds = []) => ({
  sessionsRoot: fixture,
  archivedIds: () => ['session-root', 'session-dead'],
  liveIds: () => liveIds,
  headers: async () => [
    { id: 'session-root' },
    { id: 'session-child', parentSessionId: 'session-root' },
    { id: 'session-dead' },
  ],
  unarchive: async (id) => { unarchived.push(id) },
})

await testAsync('findSessionDirs locates a session across project dirs', async () => {
  const hits = await findSessionDirs(fixture, 'session-root')
  assert.deepEqual(hits, [join(projectA, 'session-root')])
  assert.deepEqual(await findSessionDirs(fixture, 'session-absent'), [])
})
await testAsync('statusOf reports live subtree blocking and descendant count', async () => {
  const rows = await statusOf(['session-root', 'session-dead', 'session-foreign'], makeDeps(['session-child']))
  assert.equal(rows['session-root'].archived, true)
  assert.equal(rows['session-root'].blockedLive, true)
  assert.equal(rows['session-root'].liveCount, 1)
  assert.equal(rows['session-root'].subtreeSize, 2)
  assert.equal(rows['session-root'].hasLog, true)
  assert.equal(rows['session-dead'].blockedLive, false)
  assert.equal(rows['session-dead'].subtreeSize, 1)
  assert.equal(rows['session-foreign'].archived, false)
})
await testAsync('statusOf degrades gracefully when residue probes are absent', async () => {
  const rows = await statusOf(['session-root'], makeDeps())
  assert.equal(rows['session-root'].hasCache, undefined)
  assert.equal(rows['session-root'].workspaceRefs, undefined)
  assert.equal(rows['session-root'].hasSpill, undefined)
})
await testAsync('statusOf surfaces residue when probes are provided', async () => {
  const deps = makeDeps()
  deps.cacheHas = (id) => id === 'session-root'
  deps.workspaceRefCount = () => 2
  deps.spillHas = async () => true
  const rows = await statusOf(['session-root'], deps)
  assert.equal(rows['session-root'].hasCache, true)
  assert.equal(rows['session-root'].workspaceRefs, 2)
  assert.equal(rows['session-root'].hasSpill, true)
})

await testAsync('performCleanup refuses live subtrees entirely', async () => {
  unarchived.length = 0
  const { results: rows } = await performCleanup({ ids: ['session-root'] }, makeDeps(['session-child']))
  assert.equal(rows[0].status, 'live')
  // 整棵子树拒绝：目录仍在、归档条目未动。
  assert.notEqual(await readFile(join(projectA, 'session-root', 'session.v3.jsonl.zstd'), 'utf8').catch(() => undefined), undefined)
  assert.deepEqual(unarchived, [])
})

await testAsync('performCleanup deletes subtree logs and prunes archive entries', async () => {
  unarchived.length = 0
  const { results: rows } = await performCleanup({ ids: ['session-root', 'session-dead'] }, makeDeps())
  assert.equal(rows[0].status, 'deleted')
  assert.deepEqual([...rows[0].removed].sort(), ['session-child', 'session-root'])
  assert.equal(rows[1].status, 'deleted')
  assert.deepEqual(rows[1].missing, ['session-dead'])
  // 子会话目录一并删除；根目录已消失；空项目目录随之移除。
  assert.deepEqual(await findSessionDirs(fixture, 'session-root'), [])
  assert.deepEqual(await findSessionDirs(fixture, 'session-child'), [])
  assert.deepEqual(await readdir(fixture), [])
  // 归档条目清理：根与死条目在归档集中，子会话不在。
  assert.deepEqual([...unarchived].sort(), ['session-dead', 'session-root'])
})

await testAsync('performCleanup refuses non-archived ids', async () => {
  unarchived.length = 0
  const { results: rows } = await performCleanup({ ids: ['session-foreign'] }, makeDeps())
  assert.equal(rows[0].status, 'not-archived')
  assert.deepEqual(unarchived, [])
})

await testAsync('performCleanup is idempotent on re-run (missing members converge)', async () => {
  const { results: rows } = await performCleanup({ ids: ['session-root'] }, makeDeps())
  assert.equal(rows[0].status, 'deleted')
  assert.deepEqual(rows[0].missing.sort(), ['session-child', 'session-root'])
})

await testAsync('performCleanup with empty ids returns no rows (pure-sweep path premise)', async () => {
  const { results: rows } = await performCleanup({ ids: [] }, makeDeps())
  assert.deepEqual(rows, [])
})

await rm(fixture, { recursive: true, force: true })

// ── 0.2.0 端到端：缓存 / 记账 / spill / 附件 GC + 孤儿清扫 ────────────────
//
// 场景：session-gone（已归档）+ session-kid（子会话）将被删除；session-keeper
// 幸存。附件 A/B 只被删除侧引用（应删），C 被 keeper 共享（应保留），
// D 只属于 keeper（不在收集集，不应动）。spill/缓存/工作台各建对应残留。

const fixture2 = await mkdtemp(join(tmpdir(), 'dsh-ac2-'))
const projectB = join(fixture2, '--proj-b--')
const projectEmpty = join(fixture2, '--proj-empty--')
await mkdir(join(projectB, 'session-gone'), { recursive: true })
await mkdir(join(projectB, 'session-kid'), { recursive: true })
await mkdir(join(projectB, 'session-keeper'), { recursive: true })
await mkdir(projectEmpty, { recursive: true })
await writeFile(join(projectB, 'session-gone', 'session.v4.jsonl.zstd'), 'x')
await writeFile(join(projectB, 'session-kid', 'session.v4.jsonl.zstd'), 'x')
await writeFile(join(projectB, 'session-keeper', 'session.v4.jsonl.zstd'), 'x')

const eventsById = new Map([
  ['session-gone', [{ type: 'user/message', data: { content: [
    { type: 'image', attachmentId: ATT_A },
    { type: 'file', attachmentId: ATT_C },
  ] } }]],
  ['session-kid', [{ type: 'user/message', data: { content: [{ type: 'file', attachmentId: ATT_B }] } }]],
  ['session-keeper', [{ type: 'user/message', data: { content: [
    { type: 'image', attachmentId: ATT_C },
    { type: 'image', attachmentId: ATT_D },
  ] } }]],
])

// 附件对象在磁盘上的真实布局（走 attachmentCandidatePaths，与宿主一致）。
const attachmentsRoot = join(fixture2, 'attachments', 'v1')
const requestImageCache = join(fixture2, 'cache', 'attachments', 'request-images')
const ALIAS_DIR_INDEX = 2 // candidates: [objects 文件, file-objects 文件, files 别名目录]
const putAttachment = async (attachmentId) => {
  for (const [index, path] of attachmentCandidatePaths(attachmentsRoot, attachmentId).entries()) {
    if (index === ALIAS_DIR_INDEX) {
      await mkdir(path, { recursive: true })
      await writeFile(join(path, 'data.bin'), 'x')
    } else {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, 'x')
    }
  }
}
const exists = async (path) => (await stat(path).catch(() => undefined)) !== undefined

await testAsync('e2e cleanup removes residue while sharing survives', async () => {
  for (const id of [ATT_A, ATT_B, ATT_C, ATT_D]) await putAttachment(id)
  await mkdir(join(requestImageCache, 'ab'), { recursive: true })
  await writeFile(join(requestImageCache, 'ab', 'variant'), 'x')
  // spill 残留：删除侧两个成员各一个目录。
  const spillRoot = join(fixture2, 'spill', 'dsh-spill-e2e')
  for (const id of ['session-gone', 'session-kid']) {
    await mkdir(join(spillRoot, spillDirName(id)), { recursive: true })
    await writeFile(join(spillRoot, spillDirName(id), 'tool-results.txt'), 'x')
  }
  // 投影缓存 fake（域表契约：keys/get/delete，delete 幂等并回传是否删除）。
  const cacheTable = new Map([
    ['session-gone', { rows: {} }],
    ['session-kid', { rows: {} }],
    ['session-keeper', { rows: {} }],
  ])
  // 工作台 fake（raw record + 官方 detachSession 契约）。
  const workspaces = [
    { record: { sessionIds: ['session-gone', 'session-keeper'] },
      async detachSession(id) { this.record.sessionIds = this.record.sessionIds.filter((x) => x !== id) } },
    { record: { sessionIds: [] },
      async detachSession(id) { this.record.sessionIds = this.record.sessionIds.filter((x) => x !== id) } },
  ]
  const archived = ['session-gone']
  const unarchived2 = []
  const flushCalls = []

  const deps = {
    sessionsRoot: fixture2,
    purgeAttachments: true,
    archivedIds: () => [...archived],
    liveIds: () => ['session-keeper'], // 幸存会话在本进程 live
    headers: async () => [
      { id: 'session-gone' },
      { id: 'session-kid', parentSessionId: 'session-gone' },
      { id: 'session-keeper' },
    ],
    unarchive: async (id) => {
      const at = archived.indexOf(id)
      if (at >= 0) archived.splice(at, 1)
      unarchived2.push(id)
    },
    readEvents: async (id) => eventsById.get(id),
    cacheIds: () => [...cacheTable.keys()],
    cacheHas: (id) => cacheTable.has(id),
    pruneCache: async (id) => {
      if (!cacheTable.has(id)) return false
      cacheTable.delete(id)
      return true
    },
    accountedIds: () => {
      const out = new Set()
      for (const ws of workspaces) for (const id of ws.record.sessionIds) out.add(id)
      return [...out]
    },
    workspaceRefCount: (id) => workspaces.filter((ws) => ws.record.sessionIds.includes(id)).length,
    detachFromWorkspaces: async (id) => {
      let n = 0
      for (const ws of workspaces) {
        if (ws.record.sessionIds.includes(id)) n += 1
        await ws.detachSession(id)
      }
      return n
    },
    removeSpill: async (id) => removeSpillDirs([spillRoot], id),
    scanElsewhere: async (candidateIds) => {
      // 模拟 persistence.list()：只扫仍有日志目录的会话。
      const found = new Set()
      for (const [id, events] of eventsById) {
        if ((await findSessionDirs(fixture2, id)).length === 0) continue
        for (const ref of collectAttachmentIds(events)) {
          if (candidateIds.has(ref)) found.add(ref)
        }
      }
      return found
    },
    removeAttachment: async (attachmentId) => {
      let removed = false
      for (const path of attachmentCandidatePaths(attachmentsRoot, attachmentId)) {
        if (!(await exists(path))) continue
        await rm(path, { recursive: true, force: true })
        removed = true
      }
      return removed
    },
    flushRequestImageCaches: async () => {
      await rm(requestImageCache, { recursive: true, force: true })
      flushCalls.push('flushed')
    },
  }

  const { results: rows } = await performCleanup({ ids: ['session-gone'] }, deps)
  assert.equal(rows[0].status, 'deleted')
  assert.deepEqual([...rows[0].removed].sort(), ['session-gone', 'session-kid'])
  // 日志 + 空项目目录：--proj-b-- 有 keeper 存活保留；--proj-empty-- 由孤儿清扫负责。
  assert.deepEqual(await findSessionDirs(fixture2, 'session-gone'), [])
  assert.deepEqual(await findSessionDirs(fixture2, 'session-kid'), [])
  assert.deepEqual((await readdir(projectB)).sort(), ['session-keeper'])
  assert.equal(await exists(projectEmpty), true)
  // 投影缓存：删除侧全清、幸存侧保留。
  assert.deepEqual([...rows[0].cachePruned].sort(), ['session-gone', 'session-kid'])
  assert.deepEqual([...cacheTable.keys()], ['session-keeper'])
  // 工作台记账：ws0 曾含 session-gone → 计 1；kid 不在任何工作台 → 不计。
  assert.equal(rows[0].detachedWorkspaces, 1)
  assert.deepEqual(workspaces[0].record.sessionIds, ['session-keeper'])
  // spill：两个成员目录都被删。
  assert.deepEqual([...rows[0].spillRemoved].sort(), ['session-gone', 'session-kid'])
  assert.deepEqual(await readdir(spillRoot), [])
  // 归档条目：session-gone 出归档集（kid 不在归档集，不调用）。
  assert.deepEqual(unarchived2, ['session-gone'])
  assert.deepEqual(archived, [])
  // 附件：A、B 独占删除（含带名别名目录）；C 共享保留；D 不在收集集不碰。
  assert.deepEqual([...rows[0].attachmentsRemoved].sort(), [ATT_A, ATT_B].sort())
  assert.deepEqual(rows[0].attachmentsKeptShared, [ATT_C])
  assert.equal(await exists(attachmentCandidatePaths(attachmentsRoot, ATT_A)[0]), false)
  assert.equal(await exists(attachmentCandidatePaths(attachmentsRoot, ATT_B)[ALIAS_DIR_INDEX]), false)
  assert.equal(await exists(attachmentCandidatePaths(attachmentsRoot, ATT_C)[0]), true)
  assert.equal(await exists(attachmentCandidatePaths(attachmentsRoot, ATT_D)[0]), true)
  // 派生缓存被整体清空。
  assert.deepEqual(flushCalls, ['flushed'])
  assert.equal(await exists(requestImageCache), false)
  // 无辅助清理失败。
  assert.deepEqual(rows[0].warnings ?? [], [])

  // ── 孤儿清扫：注入四类历史残留 ──
  cacheTable.set('session-orphan', { rows: {} })          // 1) 无日志的投影缓存
  workspaces[1].record.sessionIds.push('session-orphan')  // 2) 无日志的工作台记账
  archived.push('session-orphan')                          // 3) 死归档条目
  await mkdir(join(spillRoot, spillDirName('session-orphan')), { recursive: true }) // 4) 垃圾 id 的 spill 目录
  await writeFile(join(spillRoot, spillDirName('session-orphan'), 'stale.txt'), 'x')
  const sweep = await performSweep(deps)
  assert.deepEqual(sweep.results.cachePruned, ['session-orphan'])
  assert.deepEqual(sweep.results.workspacesDetached, [{ id: 'session-orphan', count: 1 }])
  assert.deepEqual(sweep.results.deadArchivedPruned, ['session-orphan'])
  assert.deepEqual(sweep.results.spillRemoved, ['session-orphan'])
  assert.deepEqual(sweep.results.emptyProjectDirs, [projectEmpty])
  assert.deepEqual(sweep.warnings, [])
  assert.equal(await exists(join(spillRoot, spillDirName('session-orphan'))), false)
  // 幸存会话与非空项目目录不被触碰。
  assert.deepEqual([...cacheTable.keys()], ['session-keeper'])
  assert.deepEqual(workspaces[0].record.sessionIds, ['session-keeper'])
  assert.equal(await exists(projectB), true)
  // 幂等：二次清扫全为空。
  const sweep2 = await performSweep(deps)
  assert.deepEqual(sweep2.results.cachePruned, [])
  assert.deepEqual(sweep2.results.workspacesDetached, [])
  assert.deepEqual(sweep2.results.deadArchivedPruned, [])
  assert.deepEqual(sweep2.results.spillRemoved, [])
  assert.deepEqual(sweep2.results.emptyProjectDirs, [])

  await rm(fixture2, { recursive: true, force: true })
})

// ── 0.3.0 合并语义：删除后内联全局清扫（路由层组合的端到端）──────────────
//
// 删除路径只管选中会话自身的痕迹；他处空项目目录等全局残留由紧随其后的
// performSweep 收走（宿主 /delete 路由 0.3.0 起总是这样组合），且整段幂等。

const fixture3 = await mkdtemp(join(tmpdir(), 'dsh-ac3-'))
const projectC = join(fixture3, '--proj-c--')
const projectD = join(fixture3, '--proj-d--') // 他处的空项目目录：删除路径不管，内联清扫负责
await mkdir(join(projectC, 'session-x'), { recursive: true })
await writeFile(join(projectC, 'session-x', 'session.v3.jsonl'), 'x')
await mkdir(projectD, { recursive: true })

let archived3 = ['session-x']
const unarchived3 = []
const deps3 = {
  sessionsRoot: fixture3,
  archivedIds: () => [...archived3],
  liveIds: () => [],
  headers: async () => [{ id: 'session-x' }],
  unarchive: async (id) => {
    archived3 = archived3.filter((x) => x !== id)
    unarchived3.push(id)
  },
}

await testAsync('merged delete-then-sweep cleans own and global orphans, re-run converges', async () => {
  // 第一段：删除 session-x（自身日志与项目目录 C 随删除路径消失）。
  const { results: rows } = await performCleanup({ ids: ['session-x'] }, deps3)
  assert.equal(rows[0].status, 'deleted')
  assert.deepEqual(rows[0].removed, ['session-x'])
  assert.deepEqual(unarchived3, ['session-x'])
  // 第二段：内联全局清扫——死归档条目为空（归档集已现读、条目已清），
  // 他处空项目目录被收走。
  const sweep = await performSweep(deps3)
  assert.deepEqual(sweep.results.cachePruned, [])
  assert.deepEqual(sweep.results.workspacesDetached, [])
  assert.deepEqual(sweep.results.deadArchivedPruned, [])
  assert.deepEqual(sweep.results.spillRemoved, [])
  assert.deepEqual(sweep.results.emptyProjectDirs, [projectD])
  assert.deepEqual(sweep.warnings, [])
  // 幂等：整段重跑全为 0。
  const again = await performCleanup({ ids: ['session-x'] }, deps3)
  assert.equal(again.results[0].status, 'not-archived') // 归档集已空
  const sweep2 = await performSweep(deps3)
  assert.deepEqual(sweep2.results.emptyProjectDirs, [])
  assert.deepEqual(sweep2.results.deadArchivedPruned, [])
})

await rm(fixture3, { recursive: true, force: true })

// ── 路由信任围栏（官方 /api isTrustedApiRequest 同款语义；只打守卫分支）────
await testAsync('route fence: method/trust guards precede any action', async () => {
  const routes = new Map()
  // 假 webServer 无 host 属性 → lanDeployment=false → 回环绑定语义。
  const webServer = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const webCtx = { webServer, effect: (fn) => fn(), get: () => undefined }
  const ctx = { inject: (names, cb) => cb(webCtx) }
  apply(ctx)
  const sweepRoute = routes.get('/plugins/dsh-archived-cleanup/sweep')
  assert.ok(sweepRoute, 'sweep route registered')
  const call = async (method, headers = {}, body = undefined) => {
    const writes = []
    const res = {
      headersSent: false,
      writeHead(status, heads) { this.status = status; this.heads = heads },
      end(payload) { writes.push(payload) },
    }
    await sweepRoute.handler({ method, headers, body }, res)
    return { status: res.status, payload: JSON.parse(writes[0] ?? 'null') }
  }
  assert.equal((await call('GET', { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' })).status, 405)
  assert.equal(
    (await call('POST', { origin: 'http://evil.example', host: '127.0.0.1:3080' })).status, 403,
    'cross-origin POST rejected',
  )
  assert.equal(
    (await call('POST', { origin: 'http://evil.example', host: 'evil.example' })).status, 403,
    'non-loopback Host rejected even when Origin matches (DNS-rebinding shape)',
  )
  assert.equal(
    (await call('POST', { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' })).status, 403,
    'explicit cross-site marker rejected',
  )
  assert.equal(
    (await call('POST', { host: '192.168.1.5:3080' })).status, 403,
    'origin-less non-loopback POST rejected',
  )
  // 桌面壳转发形态（dsh-app://app 经 Electron 主进程 forwardWebRequest，
  // origin/host/sec-fetch-site 被删除，Node fetch 重发 Host 为回环地址）：
  // 必须过围栏。fake 无 workspaceRegistry → 503，恰证明请求已进入 action；
  // 全程不触磁盘。
  const forwarded = await call('POST', { host: '127.0.0.1:3080' })
  assert.equal(forwarded.status, 503, 'origin-less loopback POST passes the fence (reaches the action)')
})

// ── 0.5.0 live 运行时卸载：能力探测 / 官方顺序卸载 / 三分区删除语义 ────────

await testAsync('detectLiveTeardown reports capability and missing hops', async () => {
  const storeOf = () => ({ store: new Map() })
  const mk = (sessions, agents, persistence) => ({
    get: (key) => ({ sessions, agents, sessionPersistence: persistence }[key]),
  })
  const tracker = { tracker: { writers: new Map() } }
  assert.equal(detectLiveTeardown(mk(storeOf(), storeOf(), tracker)).capable, true)
  assert.equal(detectLiveTeardown(mk(undefined, storeOf(), tracker)).capable, false)
  assert.equal(detectLiveTeardown(mk(storeOf(), {}, tracker)).capable, false)
  assert.equal(detectLiveTeardown(mk(storeOf(), storeOf(), {})).capable, false)
  assert.equal(detectLiveTeardown(mk(storeOf(), storeOf(), undefined)).capable, false)
  // get 抛错（服务缺席等）按缺 hop 处理。
  assert.equal(detectLiveTeardown({ get: () => { throw new Error('nope') } }).capable, false)
})

await testAsync('teardownLiveMember runs official-order steps and tolerates absent hops', async () => {
  const order = []
  const agent = {
    status: 'idle',
    cancel: (cause) => { order.push(`cancel:${cause.kind}`) },
    scope: { dispose: async () => { order.push('scope') } },
  }
  const handle = { close: async () => { order.push('close') } }
  const teardown = {
    agents: { get: (id) => (id === 's1' ? agent : undefined) },
    agentsStore: new Map([['s1', { detach: () => { order.push('agents-detach') } }]]),
    sessionsStore: new Map([['s1', { detach: () => { order.push('sessions-detach') } }]]),
    trackerWriters: new Map([['s1', handle]]),
  }
  const info = await teardownLiveMember('s1', teardown)
  assert.deepEqual(order, ['cancel:disposed', 'scope', 'close', 'agents-detach', 'sessions-detach'])
  assert.deepEqual(info, { agent: true, writeHandle: true })
  // 重放：本函数自身不记忆状态，各步重跑一次（幂等由官方守卫在宿主侧兜底
  // ——句柄 close 的 closing ??=、detach 的 store.get(entry) !== entry 守卫）。
  const again = await teardownLiveMember('s1', teardown)
  assert.deepEqual(again, { agent: true, writeHandle: true })
  assert.equal(order.length, 10)
})

await testAsync('teardownLiveMember refuses a running member', async () => {
  const teardown = {
    agents: { get: () => ({ status: 'running' }) },
    agentsStore: new Map(),
    sessionsStore: new Map(),
    trackerWriters: new Map(),
  }
  await assert.rejects(() => teardownLiveMember('s1', teardown), /正在运行/)
})

const fixture4 = await mkdtemp(join(tmpdir(), 'dsh-ac4-'))
const projectE = join(fixture4, '--proj-e--')
await mkdir(join(projectE, 'session-live'), { recursive: true })
await mkdir(join(projectE, 'session-cold'), { recursive: true })
await writeFile(join(projectE, 'session-live', 'session.v4.jsonl.zstd'), 'x')
await writeFile(join(projectE, 'session-cold', 'session.v4.jsonl.zstd'), 'x')
const liveLog = join(projectE, 'session-live', 'session.v4.jsonl.zstd')
const coldLog = join(projectE, 'session-cold', 'session.v4.jsonl.zstd')
const pathExists = async (path) => (await stat(path).catch(() => undefined)) !== undefined
let archived4 = ['session-live', 'session-cold']
const makeLiveDeps = (overrides = {}) => ({
  sessionsRoot: fixture4,
  archivedIds: () => [...archived4],
  liveIds: () => ['session-live'],
  headers: async () => [{ id: 'session-live' }, { id: 'session-cold' }],
  unarchive: async (id) => { archived4 = archived4.filter((x) => x !== id) },
  agentStatus: (id) => (id === 'session-live' ? 'idle' : undefined),
  liveTeardownCapable: true,
  teardownLive: async () => {},
  ...overrides,
})

await testAsync('performCleanup refuses running subtrees (status busy)', async () => {
  const { results: rows } = await performCleanup(
    { ids: ['session-live'] },
    makeLiveDeps({ agentStatus: () => 'running' }),
  )
  assert.equal(rows[0].status, 'busy')
  assert.equal(await pathExists(liveLog), true, 'running subtree keeps its log')
  assert.deepEqual(archived4, ['session-live', 'session-cold'])
})

await testAsync('performCleanup falls back to legacy refusal when disabled', async () => {
  const { results: rows } = await performCleanup(
    { ids: ['session-live'] },
    makeLiveDeps({ deleteLiveSessions: false }),
  )
  assert.equal(rows[0].status, 'live')
  assert.equal(await pathExists(liveLog), true)
  assert.deepEqual(archived4, ['session-live', 'session-cold'])
})

await testAsync('performCleanup aborts the root when memory teardown fails', async () => {
  const { results: rows } = await performCleanup(
    { ids: ['session-live'] },
    makeLiveDeps({
      teardownLive: async () => { throw new Error('handle locked') },
    }),
  )
  assert.equal(rows[0].status, 'error')
  assert.match(rows[0].message, /内存态失败/)
  assert.equal(await pathExists(liveLog), true, 'disk untouched on teardown failure')
  assert.deepEqual(archived4, ['session-live', 'session-cold'])
})

await testAsync('performCleanup tears live members down before removing logs', async () => {
  const tornLog = []
  const { results: rows } = await performCleanup(
    { ids: ['session-live', 'session-cold'] },
    makeLiveDeps({
      teardownLive: async (id) => {
        tornLog.push(id)
        if (id === 'session-live') {
          assert.equal(await pathExists(liveLog), true, 'teardown must run before fs.rm')
        }
      },
    }),
  )
  assert.equal(rows[0].status, 'deleted')
  assert.deepEqual(rows[0].tornDown, ['session-live'])
  assert.deepEqual(tornLog, ['session-live'], 'only live members are torn down')
  assert.equal(rows[1].status, 'deleted')
  assert.deepEqual(rows[1].tornDown, [])
  assert.equal(await pathExists(liveLog), false)
  assert.equal(await pathExists(coldLog), false)
  assert.deepEqual(archived4, [])
})

await testAsync('statusOf separates busy from live-idle by capability', async () => {
  // 归档集用独立闭包：前面的用例可能已清空模块级的 archived4。
  const own = { archived: ['session-live'] }
  const deps = (overrides = {}) => makeLiveDeps({
    archivedIds: () => [...own.archived],
    ...overrides,
  })
  const idle = await statusOf(['session-live'], deps())
  assert.equal(idle['session-live'].busy, false)
  assert.equal(idle['session-live'].liveIdle, 1)
  assert.equal(idle['session-live'].blockedLive, false)
  const running = await statusOf(['session-live'], deps({ agentStatus: () => 'running' }))
  assert.equal(running['session-live'].busy, true)
  assert.equal(running['session-live'].blockedLive, true)
  const legacy = await statusOf(['session-live'], deps({ liveTeardownCapable: false }))
  assert.equal(legacy['session-live'].blockedLive, true)
  assert.equal(legacy['session-live'].liveIdle, 1)
})

await testAsync('live snapshot feeds attachment GC for unmaterialized members', async () => {
  const attachmentsRoot = join(fixture4, 'attachments', 'v1')
  for (const [index, path] of attachmentCandidatePaths(attachmentsRoot, ATT_A).entries()) {
    if (index === 2) {
      await mkdir(path, { recursive: true })
      await writeFile(join(path, 'data.bin'), 'x')
    } else {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, 'x')
    }
  }
  let ghostArchived = ['session-ghost']
  const deps = {
    sessionsRoot: fixture4,
    purgeAttachments: true,
    archivedIds: () => [...ghostArchived],
    liveIds: () => ['session-ghost'],
    headers: async () => [{ id: 'session-ghost' }],
    unarchive: async (id) => { ghostArchived = ghostArchived.filter((x) => x !== id) },
    agentStatus: () => 'idle',
    liveTeardownCapable: true,
    teardownLive: async () => {},
    liveSnapshotEvents: () => [
      { type: 'user/message', data: { content: [{ type: 'image', attachmentId: ATT_A }] } },
    ],
    scanElsewhere: async () => new Set(),
    removeAttachment: async (attachmentId) => {
      let removed = false
      for (const path of attachmentCandidatePaths(attachmentsRoot, attachmentId)) {
        if (!(await pathExists(path))) continue
        await rm(path, { recursive: true, force: true })
        removed = true
      }
      return removed
    },
  }
  const { results: rows } = await performCleanup({ ids: ['session-ghost'] }, deps)
  assert.equal(rows[0].status, 'deleted')
  assert.deepEqual(rows[0].missing, ['session-ghost'], 'unmaterialized member converges as missing')
  assert.deepEqual(rows[0].tornDown, ['session-ghost'])
  assert.deepEqual(rows[0].attachmentsRemoved, [ATT_A], 'live snapshot refs are collected and GC-ed')
  assert.equal(await pathExists(attachmentCandidatePaths(attachmentsRoot, ATT_A)[0]), false)
})

await rm(fixture4, { recursive: true, force: true })

// ── 0.6.0 purge-all：排除闭包 / 候选并集 / 确认门 / 端到端 ─────────────────

await testAsync('planPurge excludes live subtree and unions all candidate sources', async () => {
  const deps = {
    liveIds: () => ['me'],
    headers: async () => [
      { id: 'me' },
      { id: 'my-child', parentSessionId: 'me' },
      { id: 'gc', parentSessionId: 'my-child' },
      { id: 'cold-a' },
      { id: 'orphan-sub', parentSessionId: 'dead-parent' },
    ],
    accountedIds: () => ['cold-a', 'ws-only'],
    cacheIds: () => ['cold-a', 'cache-only'],
    archivedIds: () => ['archived-only'],
  }
  const plan = await planPurge(deps)
  assert.deepEqual([...plan.excluded].sort(), ['gc', 'me', 'my-child'])
  assert.deepEqual(
    [...plan.candidates].sort(),
    ['archived-only', 'cache-only', 'cold-a', 'orphan-sub', 'ws-only'],
  )
  const withKeep = await planPurge(deps, ['cold-a'])
  assert.equal(withKeep.excluded.has('cold-a'), true)
  assert.equal(withKeep.candidates.includes('cold-a'), false)
})

await testAsync('purge-all route: confirm gate + end-to-end on a temp home', async () => {
  const fixture5 = await mkdtemp(join(tmpdir(), 'dsh-ac5-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = fixture5
  try {
    const projDir = join(fixture5, 'sessions', '--p5--')
    for (const id of ['me', 'my-child', 'cold']) {
      await mkdir(join(projDir, id), { recursive: true })
      await writeFile(join(projDir, id, 'session.v4.jsonl.zstd'), 'x')
    }
    const registry = makeLegacyRegistry([])
    registry.list = () => []
    registry.archiveSession = async (id) => {
      const state = registry.requireState()
      if (state.archivedSessionIds.includes(id)) return
      await registry.setState({ ...state, archivedSessionIds: [...state.archivedSessionIds, id] })
    }
    Object.defineProperty(registry, 'archivedSessionIds', {
      get() { return this.state.archivedSessionIds },
    })
    const services = {
      workspaceRegistry: registry,
      sessions: {
        list: () => [{ id: 'me', header: {} }],
        get: () => undefined,
        store: new Map(),
      },
      agents: { get: () => undefined, store: new Map() },
      sessionPersistence: {
        list: async () => [
          { header: { id: 'me' } },
          { header: { id: 'my-child', parentSession: 'me' } },
          { header: { id: 'cold' } },
        ],
      },
    }
    const routes = new Map()
    const webServer = {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    }
    const webCtx = { webServer, effect: (fn) => fn(), get: (key) => services[key] }
    const ctx = { inject: (names, cb) => cb(webCtx) }
    apply(ctx)
    const purgeRoute = routes.get('/plugins/dsh-archived-cleanup/purge-all')
    assert.ok(purgeRoute, 'purge-all route registered')
    const call = async (payload) => {
      const req = new EventEmitter()
      req.method = 'POST'
      req.headers = { host: '127.0.0.1:3080' }
      process.nextTick(() => {
        req.emit('data', Buffer.from(JSON.stringify(payload)))
        req.emit('end')
      })
      const res = {
        headersSent: false,
        writeHead(status, heads) { this.status = status; this.heads = heads },
        end(body) { this.body = body },
      }
      await purgeRoute.handler(req, res)
      return { status: res.status, payload: JSON.parse(res.body ?? 'null') }
    }
    // ① 确认串缺失/不匹配 → 400，且不发生任何归档。
    const denied = await call({ confirm: 'wrong' })
    assert.equal(denied.status, 400)
    assert.deepEqual(registry.state.archivedSessionIds, [])
    // ② 正确确认 → live 子树（me + my-child）排除，cold 归档后整根删除。
    const ok = await call({ confirm: 'purge-all-except-live' })
    assert.equal(ok.status, 200)
    assert.deepEqual([...ok.payload.excluded].sort(), ['me', 'my-child'])
    assert.equal(ok.payload.archivedCount, 1)
    assert.equal(ok.payload.results[0].id, 'cold')
    assert.equal(ok.payload.results[0].status, 'deleted')
    assert.equal(await stat(join(projDir, 'cold')).catch(() => undefined), undefined, 'cold log removed')
    assert.notEqual(
      await stat(join(projDir, 'me')).catch(() => undefined), undefined, 'live session log kept',
    )
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await rm(fixture5, { recursive: true, force: true })
  }
})

// ── 汇总 ─────────────────────────────────────────────────────────────────
let failed = 0
for (const entry of results) {
  if (entry.ok) console.log(`ok   - ${entry.label}`)
  else {
    failed += 1
    console.error(`FAIL - ${entry.label}: ${entry.error}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed > 0) process.exit(1)
