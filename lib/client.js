// 客户端半边：侧边栏的「办公室」入口 + 多员工并行的办公室页面 + 设置里的员工管理。
//
// 这个文件不是 ESM，是宿主模块系统直接加载的经典脚本：
//   window.__ModuleLoader__.load({ id, factory }) —— id 必须是包名，
//   factory 拿到 require（react 等来自页面自带的固定模块表），
//   返回 { name, inject, apply } 就是客户端插件对象。
//
// 两个界面位置：
//   sidebar.panellist（list，root）—— 侧边栏图标入口，点了切主面板
//   main（keyed，root）—— key 与入口 id 同名，切换过去就是整页
//
// 数据来自同源请求 /team/api：桌面端页面 origin 是 dsh-app://app，
// Electron 会把同源请求转发给本机 HTTP 服务并自动带上认证 cookie。

window.__ModuleLoader__.load({
  id: 'dsh-team-employees',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const h = react.createElement

    const name = 'dsh-team-employees'
    const inject = ['slots']
    const API = '/team/api'
    const PANEL_ID = 'team-office'
    const STYLE_ID = 'dsh-team-office-style'
    const POLL_MS = 5000

    const DEPARTMENT_TINT = {
      intake: '#7aa2f7',
      select: '#bb9af7',
      write: '#9ece6a',
      render: '#7dcfff',
      gate: '#e0af68',
      measure: '#ff9e64'
    }

    const CSS = `
@keyframes dshOfficeBob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-2.5px) } }
@keyframes dshOfficeType { 0%,100% { transform: translateY(0) rotate(0deg) } 50% { transform: translateY(-1.6px) rotate(-10deg) } }
@keyframes dshOfficeZzz { 0% { opacity: 0; transform: translate(0,2px) } 25% { opacity: .85 } 100% { opacity: 0; transform: translate(7px,-15px) } }
@keyframes dshOfficeGlow { 0%,100% { opacity: .3 } 50% { opacity: 1 } }
@keyframes dshOfficeFlow { to { stroke-dashoffset: -28 } }
@keyframes dshOfficeSpin { to { transform: rotate(360deg) } }
@keyframes dshOfficeBean { 0% { transform: translateY(0) scale(1); opacity: .9 } 100% { transform: translateY(-10px) scale(1.4); opacity: 0 } }
@keyframes dshOfficeBreathe { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-1.2px) } }
@keyframes dshOfficeSteam { 0% { opacity: 0; transform: translateY(1px) } 40% { opacity: .7 } 100% { opacity: 0; transform: translateY(-5px) } }
@keyframes dshOfficeStretch { 0%,100% { transform: rotate(0deg) } 50% { transform: rotate(6deg) } }
@keyframes dshOfficeRise { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } }
.dshOffice-page { animation: dshOfficeRise .28s ease-out both }
.dshOffice-card { transition: border-color .35s ease, box-shadow .35s ease, transform .18s ease }
.dshOffice-card:hover { transform: translateY(-1px) }
.dshOffice-worker-working { animation: dshOfficeBob 2.6s ease-in-out infinite }
.dshOffice-worker-standby { animation: dshOfficeBreathe 5.2s ease-in-out infinite }
.dshOffice-steam { animation: dshOfficeSteam 3s ease-out infinite }
.dshOffice-steam-b { animation-delay: 1s }
.dshOffice-stamp { animation: dshOfficeStretch 4s ease-in-out infinite; transform-origin: 50% 100% }
.dshOffice-arm-working { animation: dshOfficeType .46s ease-in-out infinite; transform-origin: 50% 0% }
.dshOffice-arm-working-b { animation-delay: .23s }
.dshOffice-screen-working { animation: dshOfficeGlow 1.8s ease-in-out infinite }
.dshOffice-zzz { animation: dshOfficeZzz 3.4s ease-out infinite }
.dshOffice-zzz-b { animation-delay: 1.1s }
.dshOffice-zzz-c { animation-delay: 2.2s }
.dshOffice-runner { animation: dshOfficeSpin 3.4s linear infinite; transform-origin: 50% 50% }
.dshOffice-belt { stroke-dasharray: 6 8 }
.dshOffice-belt-live { animation: dshOfficeFlow 1.1s linear infinite }
.dshOffice-bean { animation: dshOfficeBean 2.6s ease-out infinite }
`

    /** 幂等地注入关键帧：同一个文档里只加一次。 */
    function ensureStyle() {
      if (typeof document === 'undefined' || document === null) return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ── 样式表（跟随明暗主题：只用半透明灰 + 少量强调色） ──────────────
    const S = {
      wrap: { display: 'grid', gap: '20px', fontSize: '13px', lineHeight: 1.6, paddingBottom: '28px' },
      head: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      title: { fontSize: '16px', fontWeight: 600, margin: 0 },
      subtitle: { fontSize: '13px', fontWeight: 600, margin: '0 0 2px' },
      meta: { opacity: 0.6, fontSize: '12px' },
      card: { border: '1px solid rgba(128,128,128,0.28)', borderRadius: '12px', padding: '14px 16px', display: 'grid', gap: '10px' },
      button: { border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit', borderRadius: '7px', padding: '3px 10px', fontSize: '12px', cursor: 'pointer' },
      primary: { borderColor: 'rgba(96,165,250,0.7)', color: 'rgb(96,165,250)' },
      danger: { borderColor: 'rgba(248,113,113,0.6)', color: 'rgb(248,113,113)' },
      field: { display: 'grid', gap: '3px' },
      label: { fontSize: '11px', opacity: 0.6 },
      input: { border: '1px solid rgba(128,128,128,0.35)', background: 'rgba(128,128,128,0.08)', color: 'inherit', borderRadius: '7px', padding: '5px 8px', fontSize: '12px', width: '100%', boxSizing: 'border-box' },
      form: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '10px' },
      banner: { border: '1px solid rgba(248,113,113,0.5)', borderRadius: '8px', padding: '8px 12px', color: 'rgb(248,113,113)', fontSize: '12px' },
      hint: { border: '1px solid rgba(224,175,104,0.5)', borderRadius: '8px', padding: '8px 12px', fontSize: '12px', display: 'grid', gap: '6px' },
      pre: { margin: 0, padding: '8px 10px', background: 'rgba(128,128,128,0.12)', borderRadius: '6px', fontSize: '11px', overflowX: 'auto', whiteSpace: 'pre' },
      empty: { opacity: 0.55 },
      stat: { display: 'flex', alignItems: 'baseline', gap: '6px' },
      statValue: { fontSize: '18px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      row: { display: 'grid', gridTemplateColumns: 'minmax(96px,1.2fr) minmax(72px,1fr) minmax(88px,1fr) minmax(72px,0.9fr) minmax(0,2fr) auto', gap: '10px', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid rgba(128,128,128,0.18)' },
      headRow: { opacity: 0.55, fontSize: '11px', letterSpacing: '0.5px' },
      name: { fontWeight: 600 },
      pill: { display: 'inline-block', border: '1px solid rgba(128,128,128,0.35)', borderRadius: '999px', padding: '0 8px', fontSize: '11px', marginRight: '6px', opacity: 0.9 }
    }

    const STAGE_LABELS = {
      ingested: '已登记', scored: '已评分', scripted: '已成稿', rendered: '已成片',
      review: '待审', queued: '已放行', published: '已排期', measured: '已回采',
      archived: '已归档', killed: '已毙'
    }

    const STATE_TEXT = {
      working: '上钟中',
      standby: '待命',
      off: '空岗',
      manual: '等你'
    }

    async function request(url, options) {
      const response = await fetch(url, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...options })
      const text = await response.text()
      let payload = null
      try { payload = text.length === 0 ? null : JSON.parse(text) } catch { payload = null }
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error ?? `请求失败（HTTP ${response.status}）`)
      return payload
    }

    function useTeamData(intervalMs) {
      const [state, setState] = react.useState({ phase: 'loading', error: null, data: null })
      const [tick, setTick] = react.useState(0)
      const reload = react.useCallback(() => setTick((value) => value + 1), [])
      react.useEffect(() => {
        let cancelled = false
        setState((prev) => ({ ...prev, phase: prev.data === null ? 'loading' : 'refreshing', error: null }))
        request(API)
          .then((data) => { if (!cancelled) setState({ phase: 'ready', error: null, data }) })
          .catch((error) => { if (!cancelled) setState((prev) => ({ phase: 'failed', error: String(error?.message ?? error), data: prev.data })) })
        return () => { cancelled = true }
      }, [tick])
      // 轮询：沙箱里没有 setInterval 时自动跳过，不影响渲染
      react.useEffect(() => {
        if (typeof setInterval !== 'function' || !(intervalMs > 0)) return undefined
        const timer = setInterval(reload, intervalMs)
        return () => clearInterval(timer)
      }, [intervalMs, reload])
      return { state, reload }
    }

    function Labeled(props) {
      return h('label', { style: S.field }, h('span', { style: S.label }, props.label), props.children)
    }

    // ══ 办公室：会动的部分 ══════════════════════════════════════════════

    /**
     * 一个工位。四种状态各有一套动作：
     *   working  打字（手臂抖、屏幕亮、身体起伏）
     *   standby  待命（缓慢呼吸，桌上那杯咖啡在冒热气）
     *   manual   人工岗（屏幕上是一个等你点的勾）
     *   off      空岗（灯灭、人灰掉）
     */
    function Worker({ state, tint, size = 132 }) {
      const working = state === 'working'
      const standby = state === 'standby'
      const manual = state === 'manual'
      const off = state === 'off'
      const screenOn = working || manual
      const bodyClass = working ? 'dshOffice-worker-working' : standby ? 'dshOffice-worker-standby' : undefined

      return h('svg', {
        width: size, height: size * 0.78, viewBox: '0 0 120 94',
        style: { overflow: 'visible', opacity: off ? 0.38 : 1, transition: 'opacity .4s ease' },
        'aria-hidden': 'true'
      },
        // 墙面灯晕：上钟时呼吸
        h('ellipse', {
          cx: 60, cy: 34, rx: 48, ry: 30, fill: tint,
          className: working ? 'dshOffice-screen-working' : undefined,
          opacity: working ? 0.16 : 0.06
        }),
        // 地面
        h('rect', { x: 0, y: 88, width: 120, height: 2, rx: 1, fill: 'rgba(128,128,128,0.22)' }),
        // 椅子（靠背 + 坐垫）
        h('rect', { x: 4, y: 40, width: 7, height: 30, rx: 3.5, fill: 'rgba(128,128,128,0.32)' }),
        h('rect', { x: 8, y: 70, width: 22, height: 6, rx: 3, fill: 'rgba(128,128,128,0.32)' }),
        h('rect', { x: 12, y: 76, width: 4, height: 12, rx: 2, fill: 'rgba(128,128,128,0.22)' }),
        // 人：头 / 围脖（部门色）/ 身体
        h('g', { className: bodyClass },
          h('circle', { cx: 36, cy: 33, r: 11, fill: 'rgba(128,128,128,0.45)' }),
          h('rect', { x: 23, y: 44, width: 26, height: 5, rx: 2.5, fill: tint, opacity: off ? 0.5 : 0.95 }),
          h('rect', { x: 22, y: 48, width: 28, height: 22, rx: 9, fill: 'rgba(128,128,128,0.3)' })),
        // 手臂：打字时抖
        h('rect', {
          x: 46, y: 54, width: 18, height: 5, rx: 2.5, fill: 'rgba(128,128,128,0.5)',
          className: working ? 'dshOffice-arm-working' : undefined
        }),
        h('rect', {
          x: 46, y: 62, width: 18, height: 5, rx: 2.5, fill: 'rgba(128,128,128,0.42)',
          className: working ? 'dshOffice-arm-working dshOffice-arm-working-b' : undefined
        }),
        // 桌面 + 桌腿
        h('rect', { x: 20, y: 68, width: 92, height: 6, rx: 3, fill: 'rgba(128,128,128,0.5)' }),
        h('rect', { x: 28, y: 74, width: 5, height: 14, rx: 2.5, fill: 'rgba(128,128,128,0.35)' }),
        h('rect', { x: 100, y: 74, width: 5, height: 14, rx: 2.5, fill: 'rgba(128,128,128,0.35)' }),
        // 显示器
        h('rect', { x: 76, y: 34, width: 36, height: 28, rx: 4, fill: off ? 'rgba(128,128,128,0.25)' : '#2a2f38' }),
        h('rect', {
          x: 78, y: 36, width: 32, height: 24, rx: 3,
          fill: screenOn ? tint : 'rgba(128,128,128,0.18)',
          opacity: screenOn ? 0.55 : 1,
          className: working ? 'dshOffice-screen-working' : undefined
        }),
        h('rect', { x: 91, y: 62, width: 6, height: 6, rx: 1, fill: 'rgba(128,128,128,0.45)' }),
        h('rect', { x: 84, y: 66, width: 20, height: 3, rx: 1.5, fill: 'rgba(128,128,128,0.4)' }),
        // 屏幕内容：上钟时在滚，空岗时是「空」，人工岗是一个等你点的勾
        off
          ? h('text', { x: 94, y: 52, fontSize: 13, textAnchor: 'middle', fill: 'rgba(128,128,128,0.85)' }, '空')
          : manual
            ? h('text', { x: 94, y: 52, fontSize: 15, textAnchor: 'middle', fill: '#e0af68', className: 'dshOffice-stamp' }, '✓?')
            : h('g', { opacity: working ? 0.95 : 0.4 },
                h('rect', { x: 82, y: 42, width: 24, height: 3, rx: 1.5, fill: 'currentColor' }),
                h('rect', { x: 82, y: 48, width: 16, height: 3, rx: 1.5, fill: 'currentColor' }),
                h('rect', { x: 82, y: 54, width: 20, height: 3, rx: 1.5, fill: 'currentColor' })),
        // 键盘
        h('rect', { x: 52, y: 64, width: 22, height: 4, rx: 2, fill: 'rgba(128,128,128,0.4)' }),
        // 待命：桌上那杯咖啡在冒热气（摸鱼信号）；上钟：冒的是干活的热气
        !off && !manual
          ? h('g', null,
              h('rect', { x: 34, y: 60, width: 9, height: 8, rx: 2, fill: 'rgba(128,128,128,0.45)' }),
              h('rect', { x: 43, y: 62, width: 3, height: 4, rx: 1.5, fill: 'rgba(128,128,128,0.45)' }),
              h('g', { stroke: 'rgba(128,128,128,0.7)', strokeWidth: 1.4, fill: 'none', strokeLinecap: 'round' },
                h('path', { d: 'M36 58 q2 -3 0 -5', className: 'dshOffice-steam' }),
                h('path', { d: 'M40 58 q2 -3 0 -5', className: 'dshOffice-steam dshOffice-steam-b' })))
          : null,
        // 待命：飘 Z
        standby
          ? h('g', { fill: 'rgba(128,128,128,0.75)', fontSize: 10 },
              h('text', { x: 46, y: 26, className: 'dshOffice-zzz' }, 'z'),
              h('text', { x: 51, y: 21, className: 'dshOffice-zzz dshOffice-zzz-b', fontSize: 8 }, 'z'))
          : null)
    }

    /** 传送带：把部门串起来，有活在流的时候虚线会跑。 */
    function Belt({ departments }) {
      const width = 96
      const live = departments.some((department) => department.queue > 0)
      return h('div', { style: { ...S.card, gap: '14px' } },
        h('div', { style: S.head },
          h('span', { style: S.subtitle }, '流水线'),
          h('span', { style: S.meta }, live ? '有货在流' : '空转'),
          h('span', { style: { flex: 1 } }),
          h('span', { style: S.meta }, '登记 → 评分 → 成稿 → 成片 → 待审 → 放行 → 排期 → 回采')),
        h('div', { style: { display: 'grid', gridTemplateColumns: `repeat(${departments.length}, minmax(0,1fr))`, gap: '6px' } },
          departments.map((department) => h('div', { key: department.id, style: { display: 'grid', gap: '6px', justifyItems: 'center' } },
            h('svg', { width: width, height: 10, viewBox: `0 0 ${width} 10`, 'aria-hidden': 'true' },
              h('line', {
                x1: 0, y1: 5, x2: width, y2: 5, stroke: DEPARTMENT_TINT[department.id] ?? '#7aa2f7',
                strokeWidth: 2, opacity: department.queue > 0 ? 0.85 : 0.25,
                className: live && department.queue > 0 ? 'dshOffice-belt dshOffice-belt-live' : 'dshOffice-belt'
              })),
            h('span', { style: { fontSize: '11px', opacity: department.queue > 0 ? 1 : 0.5 } },
              department.name),
            h('span', { style: { fontSize: '11px', opacity: 0.65 } },
              department.queue > 0 ? `${STAGE_LABELS[department.stage] ?? department.stage} ${department.queue}` : '—')))))
    }

    function DepartmentCard({ department }) {
      const tint = DEPARTMENT_TINT[department.id] ?? '#7aa2f7'
      const stateText = STATE_TEXT[department.state] ?? department.state
      const badge = {
        border: `1px solid ${department.state === 'off' ? 'rgba(128,128,128,0.35)' : tint}`,
        color: department.state === 'off' ? 'inherit' : tint,
        borderRadius: '999px',
        padding: '0 8px',
        fontSize: '11px',
        opacity: department.state === 'off' ? 0.6 : 1
      }
      return h('div', {
        className: 'dshOffice-card',
        style: {
          ...S.card,
          borderColor: department.state === 'working' ? `${tint}88` : 'rgba(128,128,128,0.28)',
          boxShadow: department.state === 'working' ? `0 0 0 1px ${tint}33, 0 6px 22px -14px ${tint}` : 'none',
          gridTemplateRows: 'auto 1fr auto',
          gap: '8px'
        }
      },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
          h('span', { style: S.subtitle }, department.name),
          h('span', { style: badge }, stateText),
          h('span', { style: { flex: 1 } }),
          h('span', { style: S.meta }, department.queue > 0 ? `${department.queue} 条在手上` : '手上没活')),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '10px', alignItems: 'center' } },
          h(Worker, { state: department.state, tint }),
          h('div', { style: { display: 'grid', gap: '4px', fontSize: '12px' } },
            h('span', { style: S.meta }, department.motto),
            h('span', { style: S.meta },
              department.manual
                ? '这个工位是你'
                : department.preset === null
                  ? '没有员工：确定性代码干的活'
                  : `工牌 ${department.preset} ｜ 会话 ${department.sessions} 个`),
            department.workingOn.length > 0
              ? h('span', { style: { color: tint, fontSize: '12px' } }, `正在做：${department.workingOn.join(' / ')}`)
              : null,
            h('span', { style: S.meta },
              `这段花了 ${department.cny} CNY` +
              (department.lastActionAt === null ? '' : ` ｜ 最近动作 ${String(department.lastActionAt).replace('T', ' ').slice(0, 16)}`)))))
    }

    function OfficePage() {
      const { state, reload } = useTeamData(POLL_MS)
      const data = state.data
      const office = data?.office ?? null
      const departments = office?.departments ?? []
      const team = office?.team ?? null
      const beans = team?.tokensToday

      return h('div', { className: 'dshOffice-page', style: { ...S.wrap, height: '100%', overflowY: 'auto', padding: '18px 20px' } },
        h('div', { style: S.head },
          h('h2', { style: S.title }, data?.team ?? '我的 AI 团队'),
          h('span', { style: S.meta }, '赛博办公室 · 谁在上钟一眼看清'),
          h('span', { style: { flex: 1 } }),
          h('button', { style: S.button, onClick: reload, disabled: state.phase === 'refreshing' },
            state.phase === 'refreshing' ? '刷新中…' : '刷新')),

        state.error !== null ? h('div', { style: S.banner }, state.error) : null,
        data === null && state.error === null ? h('div', { style: S.meta }, '正在读取办公室…') : null,

        team === null ? null : h('div', { style: { ...S.card, gap: '14px' } },
          // 四个状态计数：一个萝卜一个坑
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(96px,1fr))', gap: '12px' } },
            [['上钟中', team.working, '#9ece6a'], ['待命', team.standby, '#7aa2f7'],
             ['空岗', team.off, 'rgba(128,128,128,0.75)'], ['等你', team.manual, '#e0af68']]
              .map(([label, value, tint]) => h('div', { key: label, style: { display: 'grid', gap: '2px' } },
                h('span', { style: { ...S.statValue, color: value > 0 ? tint : 'inherit', opacity: value > 0 ? 1 : 0.45 } }, String(value)),
                h('span', { style: S.meta }, `个部门${label}`)))),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '18px', alignItems: 'baseline' } },
            h('span', { style: S.meta }, `${team.liveSessions} 个会话活着`),
            h('span', { style: S.stat },
              h('span', { style: { ...S.statValue, fontSize: '15px' } }, beans === null ? '—' : String(beans)),
              h('span', { style: S.meta }, '颗咖啡豆（今天烧的 token）')),
            h('span', { style: S.stat },
              h('span', { style: { ...S.statValue, fontSize: '15px' } }, team.spendToday === null ? '—' : String(team.spendToday.amount)),
              h('span', { style: S.meta }, `元今天已花 ｜ 余额 ${team.balance === null ? '—' : team.balance.amount}`)))),

        departments.length > 0 ? h(Belt, { departments }) : null,

        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: '12px' } },
          departments.map((department) => h(DepartmentCard, { key: department.id, department }))),

        h('div', { style: S.meta },
          '部门状态来自活着的会话：开着 turn 就是「上钟中」，待在工位没活就是「待命」，没有会话就是「空岗」。' +
          '质检台永远是你坐班——员工推不动人工闸门。'))
    }

    /** 侧边栏图标：一间小办公室。 */
    function OfficeIcon(props) {
      const size = props?.size ?? 18
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true'
      },
        h('path', { d: 'M3 21h18' }),
        h('path', { d: 'M5 21V9l7-5 7 5v12' }),
        h('path', { d: 'M9.5 21v-5.5h5V21' }),
        h('circle', { cx: 12, cy: 10.5, r: 1.2, fill: 'currentColor', stroke: 'none' }))
    }

    // ══ 设置里的员工管理（保留：增删改花名册） ══════════════════════════

    function EmployeeForm({ draft, presets, busy, onCancel, onSubmit }) {
      const [form, setForm] = react.useState(draft)
      react.useEffect(() => setForm(draft), [draft])
      const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))
      const known = presets.some((preset) => preset.id === form.preset)
      return h('div', { style: S.card },
        h('div', { style: S.head },
          h('h3', { style: S.title }, draft.isNew ? '新增员工' : `编辑 ${draft.name || draft.id}`),
          h('span', { style: S.meta }, 'id 同时是模式 id，只能小写字母数字连字符')),
        h('div', { style: S.form },
          h(Labeled, { label: 'id' }, h('input', { style: S.input, value: form.id, disabled: !draft.isNew, onChange: set('id'), placeholder: 'scout' })),
          h(Labeled, { label: '名字' }, h('input', { style: S.input, value: form.name, onChange: set('name'), placeholder: '阿研' })),
          h(Labeled, { label: '岗位' }, h('input', { style: S.input, value: form.role, onChange: set('role'), placeholder: '情报员工' })),
          h(Labeled, { label: '模式（工牌）' },
            presets.length === 0
              ? h('input', { style: S.input, value: form.preset, onChange: set('preset'), placeholder: 'scout' })
              : h('select', { style: S.input, value: form.preset, onChange: set('preset') },
                  h('option', { value: form.preset }, known ? form.preset : `${form.preset}（缺工牌）`),
                  presets.filter((preset) => preset.id !== form.preset)
                    .map((preset) => h('option', { key: preset.id, value: preset.id }, `${preset.name}（${preset.id}）`)))),
          h(Labeled, { label: '模型（留空=会话默认）' }, h('input', { style: S.input, value: form.model, onChange: set('model'), placeholder: '留空即可' })),
          h(Labeled, { label: '备注（他做什么、不做什么）' }, h('input', { style: S.input, value: form.note, onChange: set('note'), placeholder: '只检索、只核实、只出简报' }))),
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('button', { style: { ...S.button, ...S.primary }, disabled: busy, onClick: () => onSubmit(form) }, busy ? '保存中…' : '保存'),
          h('button', { style: S.button, disabled: busy, onClick: onCancel }, '取消')),
        !known && form.preset
          ? h('div', { style: S.meta }, `「${form.preset}」这个 id 还没有工牌：员工能进花名册，但新建会话里没有他这个模式。`)
          : null)
    }

    function Pipeline(props) {
      const content = props.content
      if (content === null || content === undefined) {
        return h('div', { style: S.card }, h('span', { style: S.empty }, '读不到流水线数据。'))
      }
      const pills = Object.keys(content.byStage)
        .filter((stage) => content.byStage[stage] > 0)
        .map((stage) => h('span', { key: stage, style: S.pill }, `${STAGE_LABELS[stage] ?? stage} ${content.byStage[stage]}`))
      return h('div', { style: S.card },
        h('div', { style: S.head },
          h('h3', { style: S.title }, '内容流水线'),
          h('span', { style: S.meta },
            `共 ${content.total} 条 ｜ 成本 ${content.cost.cny} CNY / ${content.cost.tokens} tokens ｜ ` +
            (content.weights === null ? '权重表还没有样本' : `权重 v${content.weights.version}（${content.weights.samples} 条样本）`))),
        h('div', null, pills.length === 0 ? h('span', { style: S.empty }, '队列是空的。') : pills),
        h('div', { style: S.field },
          h('span', { style: S.label }, `等你裁决：${content.review.length} 条`),
          content.review.length === 0
            ? h('span', { style: S.empty }, '没有待审条目。')
            : h('div', { style: { display: 'grid', gap: '4px' } },
                content.review.map((row) => h('div', { key: row.id, style: { fontSize: '12px' } },
                  h('code', null, row.id), ` ${row.topic}`,
                  row.total === null ? '' : ` ｜ 分 ${row.total}`,
                  row.owner ? ` ｜ ${row.owner}` : '')))))
    }

    function TeamSection() {
      const { state, reload } = useTeamData(0)
      const [draft, setDraft] = react.useState(null)
      const [notice, setNotice] = react.useState(null)
      const [busy, setBusy] = react.useState(false)

      const data = state.data
      const presets = data?.presets ?? []
      const employees = data?.employees ?? []

      const submit = async (form) => {
        setBusy(true)
        setNotice(null)
        try {
          const payload = await request(API, { method: 'POST', body: JSON.stringify({ action: 'upsert', employee: form }) })
          setDraft(null)
          setNotice(payload?.warning === undefined
            ? { kind: 'ok', text: '已保存。' }
            : { kind: 'warn', text: payload.warning, snippet: payload.snippet })
          reload()
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      const remove = async (employee) => {
        setBusy(true)
        setNotice(null)
        try {
          await request(API, { method: 'POST', body: JSON.stringify({ action: 'remove', employee: { id: employee.id } }) })
          setNotice({ kind: 'ok', text: `已把「${employee.name ?? employee.id}」移出花名册（工牌还在，模式还在）。` })
          reload()
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      const emptyDraft = { isNew: true, id: '', name: '', role: '', preset: '', model: '', note: '' }
      const knownIds = new Set(presets.map((preset) => preset.id))

      return h('div', { style: S.wrap },
        h('div', { style: S.head },
          h('h2', { style: S.title }, data?.team ?? '团队'),
          h('span', { style: S.meta },
            `${employees.length} 人在岗 ｜ ${presets.length} 张工牌 ｜ 数据在 ${data?.root ?? '$DSH_HOME/team'}`),
          h('span', { style: { flex: 1 } }),
          h('button', { style: S.button, onClick: reload, disabled: state.phase === 'refreshing' },
            state.phase === 'refreshing' ? '刷新中…' : '刷新'),
          h('button', { style: { ...S.button, ...S.primary }, onClick: () => setDraft(draft === null ? emptyDraft : null) },
            draft === null ? '＋ 新增员工' : '收起表单')),

        state.error !== null ? h('div', { style: S.banner }, state.error) : null,
        notice !== null
          ? h('div', { style: notice.kind === 'error' ? S.banner : S.hint },
              h('span', null, notice.text),
              notice.snippet ? h('pre', { style: S.pre }, notice.snippet) : null)
          : null,

        draft !== null ? h(EmployeeForm, { draft, presets, busy, onCancel: () => setDraft(null), onSubmit: submit }) : null,

        h('div', { style: S.card },
          h('div', { style: { ...S.row, ...S.headRow } },
            h('span', null, '名字'), h('span', null, '岗位'), h('span', null, '模式'),
            h('span', null, '模型'), h('span', null, '备注'), h('span', null, '')),
          state.phase === 'loading'
            ? h('span', { style: S.empty }, '正在读取花名册…')
            : employees.length === 0
              ? h('span', { style: S.empty }, '还没有员工。点右上角「＋ 新增员工」。')
              : employees.map((employee) => h('div', { key: employee.id, style: S.row },
                  h('span', { style: S.name }, employee.name ?? employee.id),
                  h('span', { style: S.meta }, employee.role ?? ''),
                  h('span', { style: S.meta }, employee.preset ?? employee.id,
                    knownIds.has(employee.preset ?? employee.id) ? null : h('span', { style: { opacity: 0.8 } }, ' ⚠')),
                  h('span', { style: S.meta }, employee.model?.length > 0 ? employee.model : '会话默认'),
                  h('span', { style: S.meta }, employee.note ?? ''),
                  h('span', { style: { display: 'flex', gap: '6px' } },
                    h('button', { style: S.button, disabled: busy, onClick: () => setDraft({ ...employee, isNew: false }) }, '编辑'),
                    h('button', { style: { ...S.button, ...S.danger }, disabled: busy, onClick: () => remove(employee) }, '移出'))))),

        h(Pipeline, { content: data?.content }),

        h('div', { style: S.card },
          h('div', { style: S.head },
            h('h3', { style: S.title }, '最近工作'),
            h('span', { style: S.meta }, '员工调用 team_log 写下的记录')),
          (data?.journal ?? []).length === 0
            ? h('span', { style: S.empty }, '还没有记录。')
            : h('div', { style: { display: 'grid', gap: '4px' } },
                (data?.journal ?? []).slice().reverse().slice(0, 10).map((entry, index) => h('div', {
                  key: `${entry?.at ?? ''}-${index}`,
                  style: { display: 'grid', gridTemplateColumns: '100px 64px 56px 1fr', gap: '8px', fontSize: '12px' }
                },
                  h('span', { style: S.meta }, String(entry?.at ?? '').replace('T', ' ').slice(0, 16)),
                  h('span', null, entry?.employee ?? ''),
                  h('span', { style: { opacity: 0.8 } }, entry?.status ?? '进行中'),
                  h('span', { style: S.meta }, entry?.summary ?? ''))))),

        h('div', { style: S.meta },
          '员工 = 花名册里的一条 + cordis.patch.yml 里的一张工牌。花名册决定「谁在岗」，工牌决定「他能干什么」。' +
          '想看他们现在在干嘛，点侧边栏的办公室图标。'))
    }

    function apply(ctx) {
      ensureStyle()
      if (ctx?.slots?.inject === undefined) return

      // 侧边栏入口：点了切主面板
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 12,
        label: () => '办公室'
      }, OfficeIcon))

      // 整页办公室：main 是 keyed 槽，key 必须和入口 id 一致
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID
      }, OfficePage))

      // 设置里那一节保留：增删改花名册
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'team-employees',
        order: 25,
        label: () => '员工'
      }, TeamSection))
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})
