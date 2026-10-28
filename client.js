// dsh-archived-cleanup — browser half.
//
// 在「设置」面板注册「归档会话清理」页（settings.section，order 26，紧跟
// 官方「已归档会话」页的 25）。行数据与官方页同源：workspace follow feed 的
// archivedSessionIds（倒序）∩ 已加载 Session summaries；归档集中没有
// summary 的死条目单独分组（勾选删除 = 仅清出注册表）。
//
// 交互：每行 checkbox + 工具条（全选 / 已选计数 / 唯一动作按钮）。挂载时
// POST status 预标注子树状态与残留面（缓存/工作台记录/暂存标记）：
// 「正在运行」禁选（先停止）；「使用中」行在宿主具备 live 运行时卸载能力
// （0.5.0，status 响应 liveTeardown.capable）时可选——删除时宿主先按官方
// teardown 同款步骤卸载内存态再删盘，@ 引用列表即时消失；能力不可用时
// 退回「重启 DSH 后可删」并禁选（0.4.0 语义）。清理经宿主 Modal/
// Button 原语确认（dsh-vision-tool 清理确认同款，不再用 window.confirm 的
// OS 对话框；运行中 Esc/遮罩/取消不关窗，请求级失败保留对话框展示错误），
// 文案含宿主按 parentSession 闭包算出的子会话数与清理范围；执行 POST
// delete（宿主展开子树并整棵判定，依次清日志+空项目目录、投影缓存、工作
// 台记账、归档条目、spill 暂存、独占附件），归档集经 domain/changed → feed
// archived 增量自动到达、行随之出列（客户端 sessions 服务并无 refresh 方法，
// 0.3.x 曾调的 ctx.sessions.refresh() 恒为静默 no-op，0.4.0 起移除）。结果
// 摘要逐类显示清理计数与 warnings（辅助清理失败不阻断，可重跑）；「仍在
// 使用」的拒删行单列提示——live 会话在重启 DSH 前无法删除，期间侧栏与
// @ 引用列表仍会显示它们（@ 候选由宿主每次按键实时查询 live 内存 ∪ 磁盘
// 日志语料，删除成功即消失，删除被拒则原样保留）。
//
// 页脚不再单设「清扫孤儿数据」按钮（0.3.0 起合并）：工具条唯一按钮在勾选
// 会话时为「彻底删除…」，空选集时为「清扫孤儿数据…」；两种形态都走
// POST delete——宿主在删除完成后总是顺带执行一次全局孤儿清扫（幂等，
// 只碰既无日志又非 live 的悬空数据），空选集即纯清扫。
//
// 加载形式：手写 ClientModuleLoader 工厂（tsdown 对内置包 emit 的同一包
// 装）；外部 require 是 'react' 与 '@deepseek-ai/dsh-client-ui-primitives'
// （两者都在 shell 静态模块表，见 client/web seed.ts）。本包经
// plugin_manager install_bundle 安装为 profile bundle，宿主 client-modules
// 服务提供本文件；已打开的页面随 HMR 实时组合拿到，改动约 1 秒内热生效。

window.__ModuleLoader__.load({
  id: 'dsh-archived-cleanup',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    // 宿主静态模块表（client/web seed.ts）暴露 ui-primitives：Modal/Button
    // 原语经 require 直接命中种子表，零构建装配（dsh-vision-tool 同款先例）。
    const { Modal, Button } = require('@deepseek-ai/dsh-client-ui-primitives')

    const STATUS_URL = '/plugins/dsh-archived-cleanup/status'
    const DELETE_URL = '/plugins/dsh-archived-cleanup/delete'

    /** 本节在设置导航里的显示名（DOM 图标协调也按它匹配本节按钮）。 */
    const sectionLabel = () => '归档会话清理'

    // ── 设置导航行的垃圾桶图标 ──────────────────────────────────────────────
    //
    // 宿主设置壳（ui-settings-general SettingsRoot）的导航图标是壳内写死的
    // 按 section id 的 switch（models/agent-presets/plugins 三个专属，其余
    // 一律回落齿轮），settings.section 的 Slot 契约（{id, order, label}）
    // 没有图标位——正规注册改不了它。这里在浏览器侧做精准 DOM 协调
    // （dsh-vision-tool 的 installEyeIcon 同款先例）：按钮命中本节 label
    // 时，隐藏齿轮 SVG（不删除——React 仍持有该节点，删除会破坏其协调），
    // 在其前插入一枚宿主 IconTrashOutline16（ic_ds_trash_outline_16）逐字
    // 复制的垃圾桶图标，与相邻官方图标同风格。MutationObserver 驱动、
    // 幂等、可自愈（React 重渲染重建行后自动重新套用），插件卸载时还原。
    const TRASH_SVG =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M14.4782 4.84067L14.2138 10.1152C14.1102 12.1872 14.067 13.0115 13.3866 13.9607C13.1044 14.3546 12.7498 14.6912 12.3424 14.9535C11.8239 15.2872 11.2415 15.4316 10.5585 15.4998C9.88727 15.5668 9.04946 15.5656 7.99998 15.5656C6.95051 15.5656 6.1127 15.5668 5.44142 15.4998C4.75851 15.4316 4.17602 15.2872 3.65753 14.9535C3.25012 14.6912 2.89559 14.3546 2.61332 13.9607C1.93296 13.0115 1.88979 12.1872 1.78619 10.1152L1.52179 4.84067L2.89006 4.77277L3.15343 10.0463C3.26221 12.2218 3.32452 12.6015 3.72646 13.1624C3.90825 13.4161 4.13686 13.6334 4.39927 13.8023C4.66204 13.9714 5.00263 14.0792 5.57825 14.1367C6.16562 14.1953 6.92298 14.1963 7.99998 14.1963C9.07699 14.1963 9.83434 14.1953 10.4217 14.1367C10.9973 14.0792 11.3379 13.9714 11.6007 13.8023C11.8631 13.6334 12.0917 13.4161 12.2735 13.1624C12.6755 12.6015 12.7378 12.2218 12.8465 10.0463L13.1099 4.77277L14.4782 4.84067ZM5.43011 6.22849H6.7994V11.3909H5.43011V6.22849ZM9.20056 6.22849H10.5699V11.3909H9.20056V6.22849ZM8.53597 0.434431C9.17976 0.434431 9.6522 0.426926 10.0966 0.571258C10.2357 0.616451 10.3717 0.672554 10.502 0.738948C10.9182 0.951107 11.2464 1.29099 11.7015 1.74612L12.4978 2.54136H15.3742V3.91169H0.625732V2.54136H3.50218L4.29845 1.74612C4.75358 1.29099 5.08174 0.951107 5.49801 0.738948C5.62831 0.672554 5.76425 0.616451 5.90334 0.571258C6.34776 0.426926 6.82021 0.434431 7.46399 0.434431H8.53597ZM7.46399 1.80476C6.73208 1.80476 6.51641 1.81187 6.32617 1.87369C6.25545 1.89667 6.18668 1.92533 6.12041 1.95907C5.96398 2.03878 5.82348 2.16253 5.44142 2.54136H10.5585C10.1765 2.16253 10.036 2.03878 9.87955 1.95907C9.81329 1.92533 9.74452 1.89667 9.6738 1.87369C9.48356 1.81187 9.26789 1.80476 8.53597 1.80476H7.46399Z" fill="currentColor"/>' +
      '</svg>'

    const trashNodes = new Set() // 已插入的垃圾桶节点（卸载还原用）

    const buildTrash = (gearSvg) => {
      const template = document.createElement('template')
      template.innerHTML = TRASH_SVG
      const trash = template.content.firstChild.cloneNode(true)
      // 沿用齿轮的 class（壳 CSS 模块的 navIcon 样式）与显式尺寸。
      const moved = gearSvg.getAttribute('class')
      if (moved !== null && moved !== '') trash.setAttribute('class', moved)
      const width = gearSvg.getAttribute('width')
      const height = gearSvg.getAttribute('height')
      if (width !== null) trash.setAttribute('width', width)
      if (height !== null) trash.setAttribute('height', height)
      trash.setAttribute('data-ac-trash', '1')
      return trash
    }

    /** 幂等协调：命中 label 的导航按钮 = 齿轮隐藏 + 垃圾桶就位。 */
    const reconcileTrashIcon = () => {
      const label = sectionLabel()
      for (const button of document.querySelectorAll('nav button')) {
        const span = [...button.querySelectorAll('span')].find(
          (node) => node.textContent.trim() === label,
        )
        if (span === undefined) continue
        const svgs = [...button.querySelectorAll('svg')]
        if (svgs.length === 0) continue
        const trash = svgs.find((svg) => svg.getAttribute('data-ac-trash') === '1')
        const gear = svgs.find((svg) => svg.getAttribute('data-ac-trash') !== '1')
        if (gear !== undefined && gear.style.display !== 'none') gear.style.display = 'none'
        if (trash === undefined && gear !== undefined) {
          const node = buildTrash(gear)
          gear.parentNode.insertBefore(node, gear)
          trashNodes.add(node)
        }
      }
    }

    const installTrashIcon = () => {
      reconcileTrashIcon()
      // 门闩尽量便宜：仅当新增子树里有 nav、或变更点位于某个 nav 内时才
      // 扫描（流式转录的变更既不含 nav 也不在 nav 内，直接跳过）。
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          const insideNav =
            mutation.target.nodeType === 1 && mutation.target.closest('nav') !== null
          const addsNav =
            !insideNav
            && [...mutation.addedNodes].some(
              (node) => node.nodeType === 1 && node.querySelector('nav') !== null,
            )
          if (insideNav || addsNav) {
            reconcileTrashIcon()
            return
          }
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => {
        observer.disconnect()
        // 还原：移除垃圾桶、取消齿轮隐藏。
        for (const node of trashNodes) {
          if (node.isConnected) node.remove()
        }
        trashNodes.clear()
        for (const svg of document.querySelectorAll('nav svg[data-ac-trash="1"]')) svg.remove()
        for (const button of document.querySelectorAll('nav button')) {
          for (const svg of button.querySelectorAll('svg')) {
            if (svg.getAttribute('data-ac-trash') !== '1' && svg.style.display === 'none') {
              svg.style.display = ''
            }
          }
        }
      }
    }

    // ── 样式：复刻宿主设置页的字段配方（--dsw-alias-* token），类名加
    //    dsh-ac- 前缀避免碰撞；style 元素随插件 effect 生命周期注入/移除。
    const SECTION_STYLES = `
.dsh-ac-root { display: flex; flex-direction: column; gap: 12px; max-width: 720px; }
.dsh-ac-title { font-size: 16px; font-weight: 500; line-height: 24px; }
.dsh-ac-hint { font-size: 12px; line-height: 18px; margin: 0; color: var(--dsw-alias-label-tertiary); }
.dsh-ac-toolbar {
  display: flex; align-items: center; gap: 10px; padding: 8px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l4);
}
.dsh-ac-toolbarLabel {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
  cursor: pointer; user-select: none;
}
.dsh-ac-toolbarLabel input { cursor: pointer; }
.dsh-ac-count { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsh-ac-spacer { flex: 1; }
.dsh-ac-deleteButton {
  box-sizing: border-box; display: inline-flex; align-items: center;
  height: 28px; padding: 0 12px; border: none; border-radius: 14px;
  background: transparent; color: var(--dsw-alias-state-error-primary);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
.dsh-ac-deleteButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-ac-deleteButton:disabled { opacity: 0.6; cursor: default; }
.dsh-ac-list { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.dsh-ac-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; border-radius: 10px;
}
.dsh-ac-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-ac-row input[type='checkbox'] { cursor: pointer; flex-shrink: 0; }
.dsh-ac-row input[type='checkbox']:disabled { cursor: default; }
.dsh-ac-identity { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.dsh-ac-rowTitle {
  font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-ac-rowMeta { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsh-ac-rowState { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); flex-shrink: 0; }
.dsh-ac-rowStateLive { color: var(--dsw-alias-state-warn-label, #b45309); }
.dsh-ac-groupTitle { font-size: 12px; font-weight: 500; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsh-ac-status { font-size: 12px; line-height: 18px; margin: 0; color: var(--dsw-alias-label-tertiary); }
.dsh-ac-statusError { color: var(--dsw-alias-state-error-primary); }
.dsh-ac-statusOk { color: var(--dsh-alias-state-success-primary); }
.dsh-ac-statusWarn { color: var(--dsw-alias-state-warn-label, #b45309); }
.dsh-ac-statusList {
  display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0;
  list-style: none; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-state-warn-label, #b45309);
}
.dsh-ac-footer {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding-top: 8px; border-top: 0.5px solid var(--dsw-alias-border-l4);
}
.dsh-ac-sweepButton {
  box-sizing: border-box; display: inline-flex; align-items: center;
  height: 28px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 14px; background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
.dsh-ac-sweepButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-ac-sweepButton:disabled { opacity: 0.6; cursor: default; }
.dsh-ac-failures {
  display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0;
  list-style: none; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}
/* 清理确认对话框（仿 ui-settings-models 的 .deleteDialog/.deleteConfirm）。 */
.dsh-ac-dialog { width: min(480px, 100%); }
.dsh-ac-dangerConfirm:not(:disabled) {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}
.dsh-ac-dangerConfirm:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
}
`

    const installStyles = () => {
      const element = document.createElement('style')
      element.id = 'dsh-archived-cleanup-styles'
      element.textContent = SECTION_STYLES
      document.head.appendChild(element)
      return () => { element.remove() }
    }

    /** 紧凑相对时间（官方页 relativeTime 的中文简化版）。 */
    function timeLabel(updatedAt, now) {
      const delta = Math.max(0, now - updatedAt)
      const minutes = Math.floor(delta / 60000)
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return `${minutes}分钟前`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}小时前`
      const days = Math.floor(hours / 24)
      if (days < 30) return `${days}天前`
      const months = Math.floor(days / 30)
      if (months < 12) return `${months}个月前`
      return `${Math.floor(months / 12)}年前`
    }

    /** 同源 POST JSON（vision-tool 同款守卫由宿主侧执行）。 */
    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || !payload || payload.ok !== true) {
        throw new Error(payload && payload.error ? String(payload.error) : `HTTP ${response.status}`)
      }
      return payload
    }

    function ArchivedCleanupSection(props) {
      const h = React.createElement
      const useSessions = props?.useSessions
      const useWorkspaces = props?.useWorkspaces
      const sessions = useSessions !== undefined ? useSessions((state) => state) : undefined
      const workspaces = useWorkspaces !== undefined ? useWorkspaces((state) => state.items) : undefined
      const archivedIds = useWorkspaces !== undefined ? useWorkspaces((state) => state.archivedSessionIds) : undefined

      const [checked, setChecked] = React.useState(() => new Set())
      const [statusMap, setStatusMap] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [busyKind, setBusyKind] = React.useState(null) // null | 'delete' | 'sweep'
      const [summary, setSummary] = React.useState(null)
      const [sweepReport, setSweepReport] = React.useState(null)
      const [pending, setPending] = React.useState(null) // null | { kind, roots, extra }：确认对话框打开时快照
      const [pendingError, setPendingError] = React.useState('') // 请求级错误（保留对话框展示）
      const [liveCapability, setLiveCapability] = React.useState(false) // 宿主 live 运行时卸载能力（status 响应）

      const idsKey = Array.isArray(archivedIds) ? archivedIds.join('\n') : ''

      // 挂载 / 归档集变化时预标注 live 子树与死条目。
      React.useEffect(() => {
        const ids = idsKey === '' ? [] : idsKey.split('\n')
        if (ids.length === 0) {
          setStatusMap({})
          return undefined
        }
        let cancelled = false
        postJson(STATUS_URL, { ids })
          .then((payload) => {
            if (cancelled) return
            setLiveCapability(payload.liveTeardown?.capable === true)
            setStatusMap(payload.results ?? {})
          })
          .catch(() => { if (!cancelled) setStatusMap({}) })
        return () => { cancelled = true }
      }, [idsKey])

      // 勾选集跟随行集收缩：消失的 id（已删除/已恢复）自动出选。
      React.useEffect(() => {
        setChecked((previous) => {
          const alive = new Set(idsKey === '' ? [] : idsKey.split('\n'))
          let changed = false
          const next = new Set()
          for (const id of previous) {
            if (alive.has(id)) next.add(id)
            else changed = true
          }
          return changed ? next : previous
        })
      }, [idsKey])

      if (useSessions === undefined || useWorkspaces === undefined) {
        return h('div', { className: 'dsh-ac-root' },
          h('div', { className: 'dsh-ac-title' }, sectionLabel()),
          h('p', { className: 'dsh-ac-hint' },
            '会话或工作区数据源未加载（ui-session / ui-workspace 客户端半边缺席），本页不可用。'))
      }
      if (sessions?.phase !== 'ready') {
        return h('div', { className: 'dsh-ac-root' },
          h('div', { className: 'dsh-ac-title' }, sectionLabel()),
          h('p', { className: 'dsh-ac-hint' }, '正在读取会话…'))
      }

      const summaries = sessions.byId ?? {}
      const owners = new Map()
      for (const workspace of workspaces ?? []) {
        for (const id of workspace.sessionIds ?? []) owners.set(String(id), workspace.title)
      }
      const now = Date.now()
      const ids = idsKey === '' ? [] : idsKey.split('\n')

      // 归档序最旧在前，页面最新归档在前（官方页同款倒序投影）。
      const rows = []
      const deadEntries = []
      for (let i = ids.length - 1; i >= 0; i--) {
        const id = ids[i]
        const info = summaries[id]
        if (info === undefined) {
          deadEntries.push(id)
          continue
        }
        rows.push({
          id,
          title: info.displayTitle ?? id,
          workspace: owners.get(id) ?? '未分组',
          time: timeLabel(info.updatedAt ?? now, now),
        })
      }

      const statusOfId = (id) => statusMap[id]
      const blockedLive = (id) => statusOfId(id)?.archived === true && statusOfId(id)?.blockedLive === true
      const busyOf = (id) => statusOfId(id)?.archived === true && statusOfId(id)?.busy === true
      const liveIdleOf = (id) => Math.max(0, statusOfId(id)?.liveIdle ?? 0)
      const deletable = (id) => !blockedLive(id)
      const blockedLiveCount = rows.filter((row) => blockedLive(row.id) && !busyOf(row.id)).length
      const busyCount = rows.filter((row) => busyOf(row.id)).length
      const liveIdleRowCount = rows.filter((row) => !busyOf(row.id) && liveIdleOf(row.id) > 0).length

      const selectableRows = rows.filter((row) => deletable(row.id))
      const selectableDead = deadEntries.filter(deletable)
      const allSelectable = selectableRows.length + selectableDead.length
      const checkedCount = [...checked].filter((id) => deletable(id)).length
      const allChecked = allSelectable > 0 && checkedCount === allSelectable
      const someChecked = checkedCount > 0 && !allChecked

      const toggle = (id) => {
        setChecked((previous) => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }
      const toggleAll = () => {
        setChecked((previous) => {
          const next = new Set(previous)
          const targets = [...selectableRows.map((row) => row.id), ...selectableDead]
          if (targets.every((id) => next.has(id))) {
            for (const id of targets) next.delete(id)
          } else {
            for (const id of targets) next.add(id)
          }
          return next
        })
      }

      // 单一清理动作，确认走宿主 Modal/Button 原语（dsh-vision-tool 清理确认
      // 同款先例，不再用 window.confirm 的 OS 对话框）：勾选了会话 → 删除
      // （宿主删完自动顺带全局孤儿清扫）；空选集 → 纯孤儿清扫（同一 delete
      // 路由，ids 为空数组）。打开时快照勾选集——模态期间选择不可变。
      const openConfirm = () => {
        if (busy) return
        const roots = [...checked].filter(deletable)
        let extra = 0
        for (const id of roots) {
          extra += Math.max(0, (statusOfId(id)?.subtreeSize ?? 1) - 1)
        }
        setPendingError('')
        setPending({ kind: roots.length > 0 ? 'delete' : 'sweep', roots, extra })
      }

      // 运行中不关窗（Esc/遮罩/取消都拦下，vision-tool 同款）；空闲时取消即关。
      const closeDialog = () => {
        if (busy) return
        setPending(null)
        setPendingError('')
      }

      const executePending = async () => {
        if (busy || pending === null) return
        const kind = pending.kind
        const roots = pending.roots
        setBusyKind(kind)
        setBusy(true)
        setSummary(null)
        setSweepReport(null)
        try {
          const payload = await postJson(DELETE_URL, { ids: roots })
          const results = Array.isArray(payload.results) ? payload.results : []
          const byId = new Map(results.map((entry) => [entry.id, entry]))
          let okCount = 0
          const failures = []
          const pendingLive = []
          const pendingBusy = []
          const warnings = []
          const totals = {
            cachePruned: 0,
            detachedWorkspaces: 0,
            spillRemoved: 0,
            attachmentsRemoved: 0,
            attachmentsKeptShared: 0,
            liveTornDown: 0,
          }
          for (const entry of results) {
            if (entry.status === 'deleted' || entry.status === 'not-archived') {
              okCount += 1
              totals.cachePruned += (entry.cachePruned ?? []).length
              totals.detachedWorkspaces += entry.detachedWorkspaces ?? 0
              totals.spillRemoved += (entry.spillRemoved ?? []).length
              totals.attachmentsRemoved += (entry.attachmentsRemoved ?? []).length
              totals.attachmentsKeptShared += (entry.attachmentsKeptShared ?? []).length
              totals.liveTornDown += (entry.tornDown ?? []).length
              for (const line of entry.warnings ?? []) {
                warnings.push(entry.id === '' ? line : `${titleOf(entry.id)}：${line}`)
              }
            } else if (entry.status === 'live') {
              // 拒删但非失败：卸载能力不可用，重启 DSH 后可删（行保留勾选）。
              pendingLive.push(entry)
            } else if (entry.status === 'busy') {
              // 拒删但非失败：正在运行，停止后可删（行保留勾选）。
              pendingBusy.push(entry)
            } else failures.push(entry)
          }
          // 成功的根出选；失败/仍在使用/正在运行的行保留勾选便于重试。
          setChecked((previous) => {
            const next = new Set()
            for (const id of previous) {
              const entry = byId.get(id)
              if (entry === undefined || entry.status === 'deleted' || entry.status === 'not-archived') continue
              next.add(id)
            }
            return next
          })
          setSummary({ okCount, failures, pendingLive, pendingBusy, warnings, totals, kind })
          if (payload.sweep !== undefined && payload.sweep !== null) {
            setSweepReport({ results: payload.sweep.results ?? {}, warnings: payload.sweep.warnings ?? [] })
          }
          // 成功即关窗（结果文案落在页内摘要/清扫行）。行的出列依赖 workspace
          // feed 的 archived 增量；客户端 sessions 服务没有 refresh 方法，无需
          // （也无法）在此拉新基线。
          setPending(null)
          setPendingError('')
        } catch (error) {
          // 请求级失败：保留对话框在框内展示错误（页内摘要照旧）。
          setPendingError(error?.message ?? String(error))
          setSummary({ okCount: 0, failures: [{ id: '', status: 'error', message: error?.message ?? String(error) }], pendingLive: [], pendingBusy: [], warnings: [], totals: null, kind })
        } finally {
          setBusy(false)
          setBusyKind(null)
        }
      }

      /** 确认对话框正文（打开时快照的 pending 派生，去掉「确定继续？」尾巴）。 */
      const pendingDescription = () => {
        if (pending === null) return ''
        const sweepNote = '删除完成后会顺带清扫孤儿数据（已无日志的投影缓存与工作台记录、死归档条目、空项目目录）。'
        if (pending.kind === 'sweep') {
          return '将扫描并清理孤儿数据：已无日志的投影缓存与工作台记录、归档集死条目、空项目目录。' +
            '只触及「既无日志目录又不在使用中」的悬空数据，不影响任何幸存会话。'
        }
        const liveCount = pending.roots.filter((id) => liveIdleOf(id) > 0).length
        const liveNote = liveCount > 0
          ? `其中 ${liveCount} 个正在本进程内使用，删除时会先卸载其内存态（删除后 @ 引用列表即时消失；若它正开在某个标签页，删除后该标签页会失效）。`
          : ''
        return pending.roots.length === 1 && pending.extra === 0
          ? '将永久删除该已归档会话的全部本地痕迹（内存态、会话日志与空项目目录、投影缓存、工作台记录、临时暂存文件、仅被其引用的附件、注册表条目），无法恢复。' + liveNote + sweepNote
          : `将永久删除 ${pending.roots.length} 个已归档会话${pending.extra > 0 ? `（连同 ${pending.extra} 个子会话）` : ''}的全部本地痕迹（内存态、会话日志、投影缓存、工作台记录、临时暂存文件、仅被其引用的附件、注册表条目），无法恢复。${liveNote}${sweepNote}`
      }

      const renderRow = (row) => {
        const blocked = blockedLive(row.id) // running 或（卸载不可用的）live → 禁选
        const busyRow = busyOf(row.id)
        const liveIdle = liveIdleOf(row.id)
        const info = statusOfId(row.id)
        const childCount = Math.max(0, (info?.subtreeSize ?? 1) - 1)
        const residue = [
          info?.hasCache === true ? '缓存' : '',
          (info?.workspaceRefs ?? 0) > 0 ? '工作台记录' : '',
          info?.hasSpill === true ? '暂存' : '',
        ].filter(Boolean).join(' · ')
        return h(
          'li',
          { key: row.id, className: 'dsh-ac-row' },
          h('input', {
            type: 'checkbox',
            checked: checked.has(row.id),
            disabled: blocked || busy,
            onChange: () => { toggle(row.id) },
            'aria-label': `选择 ${row.title}`,
          }),
          h(
            'div',
            { className: 'dsh-ac-identity' },
            h('div', { className: 'dsh-ac-rowTitle', title: row.title }, row.title),
            h('div', { className: 'dsh-ac-rowMeta' },
              [row.workspace, row.time, childCount > 0 ? `含 ${childCount} 个子会话` : '', residue !== '' ? `残留：${residue}` : ''].filter(Boolean).join(' · ')),
          ),
          busyRow
            ? h('span', { className: 'dsh-ac-rowState dsh-ac-rowStateLive' }, '正在运行 · 停止后可删')
            : blocked
              ? h('span', { className: 'dsh-ac-rowState dsh-ac-rowStateLive' }, '使用中（本进程内已加载）· 重启 DSH 后可删')
              : liveIdle > 0
                ? h('span', { className: 'dsh-ac-rowState dsh-ac-rowStateLive' }, `使用中${liveIdle > 1 ? `（子树内 ${liveIdle} 个成员）` : ''} · 删除时将先卸载内存态`)
                : null,
        )
      }

      const renderDeadRow = (id) =>
        h(
          'li',
          { key: `dead-${id}`, className: 'dsh-ac-row' },
          h('input', {
            type: 'checkbox',
            checked: checked.has(id),
            disabled: busy,
            onChange: () => { toggle(id) },
            'aria-label': `选择失效条目 ${id}`,
          }),
          h(
            'div',
            { className: 'dsh-ac-identity' },
            h('div', { className: 'dsh-ac-rowTitle', title: id }, id),
            h('div', { className: 'dsh-ac-rowMeta' }, '会话已不存在 · 勾选删除或清扫孤儿数据都会移除该条目'),
          ),
        )

      const titleOf = (id) => rows.find((row) => row.id === id)?.title ?? id

      return h(
        'div',
        { className: 'dsh-ac-root' },
        h('div', null,
          h('div', { className: 'dsh-ac-title' }, sectionLabel()),
          h('p', { className: 'dsh-ac-hint' },
            '勾选要彻底删除的已归档会话：删除会永久移除其全部本地痕迹——本进程内存态（live 会话先卸载，无需重启 DSH）、' +
            '磁盘日志（含子会话）与空项目目录、投影缓存、工作台记录、临时暂存文件、仅被其引用的附件（被其他会话共享的附件保留），' +
            '并清出注册表归档集，无法恢复；完成后自动顺带清扫孤儿数据（已无日志的投影缓存与工作台记录、死归档条目、空项目目录）。' +
            '恢复已归档会话请用上方官方「已归档会话」页。不勾选任何会话时，按钮仅执行孤儿清扫。' +
            '正在运行的会话需先停止（归档时通常已停止）才能删除。')),
        ids.length === 0
          ? h('p', { className: 'dsh-ac-status' }, '暂无已归档会话。')
          : null,
        // 状态横幅：运行中 → 先停止；使用中且可运行时卸载 → 说明将先卸载内存
        // 态（含标签页失效提示）；卸载能力不可用 → 旧语义（重启 DSH 后可删）。
        busyCount > 0
          ? h('p', { className: 'dsh-ac-status dsh-ac-statusWarn' },
              `${busyCount} 个已归档会话正在运行，停止后即可删除。`)
          : null,
        liveCapability && liveIdleRowCount > 0
          ? h('p', { className: 'dsh-ac-status' },
              `${liveIdleRowCount} 个会话仍在使用中，删除时会先卸载其本进程内存态（删除后 @ 引用列表即时消失）；` +
              '若它正开在某个标签页，删除后该标签页会失效，建议先关闭。')
          : null,
        !liveCapability && blockedLiveCount > 0
          ? h('p', { className: 'dsh-ac-status dsh-ac-statusWarn' },
              `${blockedLiveCount} 个已归档会话仍在本进程内使用（归档不卸载内存态，且当前 DSH 缺少运行时卸载入口），` +
              '重启 DSH 后才能删除；在此之前它们会一直出现在侧栏和输入框的 @ 引用列表中。')
          : null,
        h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'dsh-ac-toolbar' },
            h(
              'label',
              { className: 'dsh-ac-toolbarLabel' },
              h('input', {
                type: 'checkbox',
                checked: allChecked,
                ref: (element) => {
                  if (element != null) element.indeterminate = someChecked
                },
                disabled: allSelectable === 0 || busy,
                onChange: toggleAll,
              }),
              '全选',
            ),
            h('span', { className: 'dsh-ac-count' }, `已选 ${checkedCount} / ${allSelectable} 项`),
            h('span', { className: 'dsh-ac-spacer' }),
            h(
              'button',
              {
                type: 'button',
                className: checkedCount > 0 ? 'dsh-ac-deleteButton' : 'dsh-ac-sweepButton',
                disabled: busy,
                onClick: () => { openConfirm() },
              },
              busy
                ? (busyKind === 'delete' ? '正在删除…' : '正在清扫…')
                : checkedCount > 0 ? '彻底删除…' : '清扫孤儿数据…',
            ),
          ),
          rows.length > 0
            ? h('ul', { className: 'dsh-ac-list' }, rows.map(renderRow))
            : null,
          deadEntries.length > 0
            ? h(
              'div',
              null,
              h('div', { className: 'dsh-ac-groupTitle' }, `会话已不存在的归档条目（${deadEntries.length}）`),
              h('ul', { className: 'dsh-ac-list' }, deadEntries.map(renderDeadRow)),
            )
            : null,
          // 纯清扫形态无删除结果：只有失败（请求级错误）时才渲染本块。
          summary !== null && (summary.kind !== 'sweep' || summary.failures.length > 0)
            ? h(
              'div',
              null,
              h(
                'p',
                { className: summary.failures.length === 0 ? 'dsh-ac-status dsh-ac-statusOk' : 'dsh-ac-status dsh-ac-statusError' },
                summary.failures.length === 0
                  ? `已彻底删除 ${summary.okCount} 个会话。`
                  : `已删除 ${summary.okCount} 个；${summary.failures.length} 个失败：`,
              ),
              // 拒删的 live 行单列：不是失败，也未被删除——重启 DSH 后可删，
              // 且在重启前侧栏与 @ 引用列表仍会显示它们。
              (summary.pendingLive ?? []).length > 0
                ? h(
                  'div',
                  null,
                  h('p', { className: 'dsh-ac-status dsh-ac-statusWarn' },
                    `未删除（仍在使用）：${summary.pendingLive.length} 个会话在本进程内仍加载于内存，` +
                    '重启 DSH 后回本页即可删除；在此之前它们仍会出现在侧栏与 @ 引用列表中：'),
                  h(
                    'ul',
                    { className: 'dsh-ac-statusList' },
                    summary.pendingLive.map((entry, index) =>
                      h('li', { key: `live-${entry.id}-${index}` },
                        `${titleOf(entry.id)}：${entry.message ?? '仍在使用，重启 DSH 后可删'}`)),
                  ),
                )
                : null,
              // 正在运行的拒删行单列：停止后即可删（无需重启）。
              (summary.pendingBusy ?? []).length > 0
                ? h(
                  'div',
                  null,
                  h('p', { className: 'dsh-ac-status dsh-ac-statusWarn' },
                    `未删除（正在运行）：${summary.pendingBusy.length} 个会话正在运行，停止后即可删除：`),
                  h(
                    'ul',
                    { className: 'dsh-ac-statusList' },
                    summary.pendingBusy.map((entry, index) =>
                      h('li', { key: `busy-${entry.id}-${index}` },
                        `${titleOf(entry.id)}：${entry.message ?? '正在运行，停止后可删'}`)),
                  ),
                )
                : null,
              summary.kind !== 'sweep' && summary.totals !== null && summary.totals !== undefined
                ? h('p', { className: 'dsh-ac-status' },
                  `附加清理：内存态卸载 ${summary.totals.liveTornDown ?? 0}` +
                  ` · 投影缓存 ${summary.totals.cachePruned} · 工作台记录 ${summary.totals.detachedWorkspaces}` +
                  ` · 暂存目录 ${summary.totals.spillRemoved} · 附件 ${summary.totals.attachmentsRemoved}` +
                  (summary.totals.attachmentsKeptShared > 0 ? `（共享保留 ${summary.totals.attachmentsKeptShared}）` : ''))
                : null,
                summary.failures.length > 0
                  ? h(
                    'ul',
                    { className: 'dsh-ac-failures' },
                    summary.failures.map((entry, index) =>
                      h('li', { key: `failure-${entry.id}-${index}` },
                        `${entry.id === '' ? '' : `${titleOf(entry.id)}：`}${entry.message ?? entry.status}`)),
                  )
                  : null,
                (summary.warnings ?? []).length > 0
                  ? h(
                    'ul',
                    { className: 'dsh-ac-statusList' },
                    summary.warnings.map((line, index) =>
                      h('li', { key: `warning-${index}` }, line)),
                  )
                  : null,
              )
              : null,
          ),
        sweepReport !== null
          ? h(
            'div',
            null,
            h('p', { className: 'dsh-ac-status dsh-ac-statusOk' },
              `孤儿清扫完成：投影缓存 ${(sweepReport.results?.cachePruned ?? []).length}` +
              ` · 工作台记录 ${(sweepReport.results?.workspacesDetached ?? []).length}` +
              ` · 死归档条目 ${(sweepReport.results?.deadArchivedPruned ?? []).length}` +
              ` · 暂存目录 ${(sweepReport.results?.spillRemoved ?? []).length}` +
              ` · 空项目目录 ${(sweepReport.results?.emptyProjectDirs ?? []).length}`),
            (sweepReport.warnings ?? []).length > 0
              ? h(
                'ul',
                { className: 'dsh-ac-statusList' },
                sweepReport.warnings.map((line, index) =>
                  h('li', { key: `sweep-warning-${index}` }, line)),
              )
              : null,
          )
          : null,
        h(
          'div',
          { className: 'dsh-ac-footer' },
          h('span', { className: 'dsh-ac-hint' },
            '删除与孤儿清扫共用上方按钮：删除完成后自动清扫一次，不勾选任何会话时单独执行。' +
            '清扫只触及「既无日志目录又不在使用中」的悬空数据，幂等，可重复执行。'),
        ),
        // 清理确认：宿主 Modal + Button 原语（仿模型页删除确认/识图清理确认）。
        h(
          Modal,
          {
            open: pending !== null,
            onClose: closeDialog,
            title: pending !== null && pending.kind === 'sweep' ? '清扫孤儿数据' : '彻底删除已归档会话',
            closeLabel: '关闭',
            description: pendingDescription(),
            className: 'dsh-ac-dialog',
            footer: h(
              React.Fragment,
              null,
              h(
                Button,
                { variant: 'outline', onClick: closeDialog, disabled: busy },
                '取消',
              ),
              h(
                Button,
                {
                  variant: 'outline',
                  className: 'dsh-ac-dangerConfirm',
                  disabled: busy,
                  onClick: () => { void executePending() },
                },
                busy
                  ? (pending !== null && pending.kind === 'sweep' ? '正在清扫…' : '正在删除…')
                  : pending !== null && pending.kind === 'sweep' ? '清扫孤儿数据' : '彻底删除',
              ),
            ),
          },
          pendingError !== ''
            ? h('p', { className: 'dsh-ac-status dsh-ac-statusError', role: 'alert' }, pendingError)
            : null,
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', function* () {
            yield ctx.slots.register(
              {
                name: 'settings.section',
                id: 'archived-cleanup',
                order: 26,
                label: sectionLabel,
                inject: () => ({}),
              },
              ArchivedCleanupSection,
            )
          }),
        'dsh-archived-cleanup: settings section',
      )
      ctx.effect(() => installStyles(), 'dsh-archived-cleanup: section styles')
      ctx.effect(() => installTrashIcon(), 'dsh-archived-cleanup: nav trash icon')
    }

    exports.apply = apply
    // 仅需 slots：行数据经 settings.section 的 props（useSessions/useWorkspaces）
    // 注入，客户端 sessions 服务本身没有本插件需要的成员（0.3.x 误调的
    // refresh() 并不存在）。
    exports.inject = ['slots']
    return module.exports
  },
})
