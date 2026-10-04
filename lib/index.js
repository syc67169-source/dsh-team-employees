// Host 平面：团队数据 + 团队面板 + 桌面界面用的 JSON 接口。
//
// 桌面（Electron）里的页面 origin 是 dsh-app://app，所有同源请求都会被宿主
// 转发到本机 HTTP 服务并自动带上认证 cookie，所以客户端插件直接 fetch('/team/api')
// 就能拿到这里的数据，不用自己拼 token。

import { readFile } from 'node:fs/promises'
import { confirmPublication, decideGate, STAGES, scriptPath, listQueue, readItemOrNull, readWeights, summarizeCost } from './content.mjs'
import { journalPath, readJournal, readRoster, rosterPath, teamRoot } from './store.mjs'
import { balanceOf, callEvents, readUsage, todaySpend } from './usage.mjs'

import { withFileLock, writeJsonAtomic } from './storage.mjs'

export const name = 'team-employees'

const PANEL_PATH = '/team'
const MAX_BODY_BYTES = 64 * 1024
const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

// ── 通用 ──────────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ))
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(`${JSON.stringify(payload, null, 2)}\n`)
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(text)
}

/** 读请求体，带体积上限；超了直接拒绝，不让一个畸形请求把内存吃满。 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

// ── 花名册读写 ────────────────────────────────────────────────────────

function requireText(value, label, max) {
  const text = String(value ?? '').trim()
  if (text.length === 0) throw new Error(`${label}不能为空`)
  if (text.length > max) throw new Error(`${label}最多 ${max} 个字`)
  return text
}

function normalizeEmployee(input) {
  const id = String(input?.id ?? '').trim().toLowerCase()
  if (!ID_PATTERN.test(id)) {
    throw new Error('员工 id 只能用小写字母开头、后接小写字母/数字/连字符，最长 32 位（它同时也是模式 id）')
  }
  return {
    id,
    preset: (() => {
      const preset = String(input?.preset ?? id).trim()
      return preset.length === 0 ? id : preset
    })(),
    name: requireText(input?.name, '名字', 40),
    role: requireText(input?.role, '岗位', 40),
    model: String(input?.model ?? '').trim().slice(0, 120),
    note: String(input?.note ?? '').trim().slice(0, 200)
  }
}

/** 原子写：先写临时文件再 rename，避免断电/并发把花名册写成半截。 */
async function writeRosterFile(roster) {
  await writeJsonAtomic(rosterPath(), roster)
}

async function mutateRoster(action, rawEmployee) {
  return withFileLock(rosterPath(), () => mutateRosterUnlocked(action, rawEmployee))
}

async function mutateRosterUnlocked(action, rawEmployee) {
  const roster = await readRoster()
  const employees = [...roster.employees]

  if (action === 'remove') {
    const id = String(rawEmployee?.id ?? '').trim().toLowerCase()
    if (id.length === 0) throw new Error('移出员工需要 id')
    const next = employees.filter((item) => String(item?.id ?? '').toLowerCase() !== id)
    if (next.length === employees.length) throw new Error(`花名册里没有 id 为「${id}」的员工`)
    const saved = { ...roster, employees: next }
    await writeRosterFile(saved)
    return { roster: saved, id }
  }

  if (action !== 'upsert') throw new Error(`不认识的操作「${action}」，只支持 upsert / remove`)

  const employee = normalizeEmployee(rawEmployee)
  const index = employees.findIndex((item) => String(item?.id ?? '').toLowerCase() === employee.id)
  if (index >= 0) employees[index] = employee
  else employees.push(employee)

  const saved = { ...roster, employees }
  await writeRosterFile(saved)
  return { roster: saved, id: employee.id }
}

// ── 数据快照（界面和 /team/api 读同一份） ─────────────────────────────

async function presetList(ctx) {
  try {
    const service = ctx.get('agentPresets')
    if (service === undefined || typeof service.list !== 'function') return []
    const rows = await service.list()
    return rows.map((row) => ({
      id: row.id,
      name: row.name ?? row.id,
      description: row.description ?? '',
      broken: row.broken ?? null
    }))
  } catch {
    return []
  }
}

async function contentOverview(items) {
  const summary = summarizeCost(items)

  const byStage = {}
  for (const stage of STAGES) byStage[stage] = 0
  for (const item of items) byStage[item.stage] = (byStage[item.stage] ?? 0) + 1

  const reviewItems = items
    .filter((item) => item.stage === 'review')
    .map((item) => ({
      id: item.id,
      topic: item.features?.topic ?? '',
      total: item.score?.total ?? null,
      owner: item.owner ?? '',
      artifacts: item.artifacts ?? [],
      scriptPath: scriptPath(item.id),
      updatedAt: item.updatedAt ?? null
    }))
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))

  const review = await Promise.all(reviewItems.map(async row => ({ ...row, script: await readFile(row.scriptPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }) })))
  const weights = await readWeights()
  return {
    total: items.length,
    byStage,
    review,
    publications: items.flatMap(item => (item.targets ?? []).filter(target => !target.confirmedAt).map(target => ({ id: item.id, ...target }))),
    cost: { cny: summary.cny, tokens: summary.tokens },
    weights: weights === null ? null : { version: weights.version ?? null, samples: weights.samples ?? null }
  }
}

async function usageOverview(usage) {
  if (usage === null) return null
  return { today: todaySpend(usage), balance: balanceOf(usage) }
}

// ── 办公室：谁在上钟 ──────────────────────────────────────────────────

/**
 * 部门编制。stage = 这个部门守哪一段流水线，preset = 哪张工牌，
 * manual = 人坐班的岗位（质检台只有用户本人能裁决）。
 */
const DEPARTMENTS = [
  { id: 'intake', name: '情报部', preset: 'scout', stage: 'ingested', motto: '找素材、核授权、登记' },
  { id: 'select', name: '选题部', preset: 'select', stage: 'scored', motto: '打分、排序、给先验' },
  { id: 'write', name: '成稿部', preset: 'write', stage: 'scripted', motto: '脚本与标题' },
  { id: 'render', name: '制作部', preset: null, stage: 'rendered', motto: '登记制作计划，实际渲染尚未接入' },
  { id: 'gate', name: '质检台', preset: null, stage: 'review', motto: '人工裁决，只有你能放行', manual: true },
  { id: 'measure', name: '数据部', preset: 'measure', stage: 'measured', motto: '回采、对账、重算权重' }
]

/**
 * 活着的会话。busy = 这个会话当前开着一轮 turn（turnBoundary 投影里
 * openTurnStartSeq 不为 null），这就是「正在干活」的判据。
 */
function liveSessions(ctx) {
  try {
    const service = ctx.get('sessions')
    if (service === undefined || typeof service.list !== 'function') return []
    const projections = ctx.get('sessionProjections')
    return service.list().map((session) => {
      let busy = false
      let title = ''
      try {
        const boundary = projections?.stateOf(session, 'turnBoundary')
        busy = boundary !== undefined && boundary !== null && boundary.openTurnStartSeq !== null
        // 标题是 session/title 事件的投影（字符串或 null），不是 header 字段
        const logged = projections?.stateOf(session, 'title')
        title = typeof logged === 'string' ? logged : ''
      } catch {
        busy = false
      }
      return {
        id: session.id,
        preset: session.header?.agentPreset ?? null,
        title,
        busy
      }
    })
  } catch {
    return []
  }
}

/** 今日 token：账本 events 里 day 等于今天的那些调用之和。 */
function tokensToday(usage) {
  if (usage === null) return null
  const key = new Date().toISOString().slice(0, 10)
  const rows = callEvents(usage).filter((event) => event?.day === key)
  if (rows.length === 0) return 0
  return rows.reduce((sum, event) => sum + (Number(event?.tokens) || 0), 0)
}

async function officeOverview(ctx, items, usage) {
  const sessions = liveSessions(ctx)

  const departments = DEPARTMENTS.map((department) => {
    const queue = items.filter((item) => item.stage === department.stage)
    const mine = department.preset === null ? [] : sessions.filter((session) => session.preset === department.preset)
    const busy = mine.filter((session) => session.busy).length
    const cny = items.reduce((sum, item) => sum + (Number(item?.cost?.byStage?.[department.stage]) || 0), 0)
    return {
      id: department.id,
      name: department.name,
      motto: department.motto,
      preset: department.preset,
      stage: department.stage,
      manual: department.manual === true,
      queue: queue.length,
      cny: Number(cny.toFixed(4)),
      sessions: mine.length,
      busySessions: busy,
      state: department.manual === true
        ? 'manual'
        : busy > 0
          ? 'working'
          : mine.length > 0 ? 'standby' : 'off',
      lastActionAt: queue.map((item) => item.updatedAt).filter(Boolean).sort().at(-1) ?? null,
      workingOn: mine.filter((session) => session.busy).map((session) => session.title).filter(Boolean)
    }
  })

  const today = usage === null ? null : todaySpend(usage)
  return {
    generatedAt: new Date().toISOString(),
    departments,
    team: {
      working: departments.filter((row) => row.state === 'working').length,
      standby: departments.filter((row) => row.state === 'standby').length,
      off: departments.filter((row) => row.state === 'off').length,
      manual: departments.filter((row) => row.state === 'manual').length,
      liveSessions: sessions.length,
      tokensToday: tokensToday(usage),
      spendToday: today,
      balance: usage === null ? null : balanceOf(usage)
    }
  }
}

async function snapshot(ctx) {
  const rows = await listQueue({ stage: null, limit: null })
  const items = (await Promise.all(rows.map(row => readItemOrNull(row.id)))).filter(Boolean)
  const ledger = await readUsage()
  const [roster, journal, presets, content, usage, office] = await Promise.all([
    readRoster(),
    readJournal(30),
    presetList(ctx),
    contentOverview(items).catch(() => null),
    usageOverview(ledger).catch(() => null),
    officeOverview(ctx, items, ledger).catch(() => null)
  ])
  return {
    root: teamRoot(),
    paths: { roster: rosterPath(), journal: journalPath() },
    team: roster.team,
    employees: roster.employees,
    presets,
    content,
    usage,
    office,
    journal
  }
}

// ── 浏览器兜底页面（桌面端用不上，但 /team 打开还能看） ────────────────

function employeeCards(employees, presets) {
  if (employees.length === 0) {
    return '<p class="empty">花名册是空的。把 employees.json 放到团队数据目录，再加几个员工。</p>'
  }
  const known = new Set(presets.map((preset) => preset.id))
  return employees.map((item) => {
    const badge = known.has(item?.preset) ? '' : '<span class="warn">缺工牌</span>'
    return `
    <article class="card">
      <header><span class="who">${escapeHtml(item?.name)}</span><span class="role">${escapeHtml(item?.role)}</span>${badge}</header>
      <p>${escapeHtml(item?.note)}</p>
      <dl>
        <dt>id</dt><dd>${escapeHtml(item?.id)}</dd>
        <dt>模式</dt><dd>${escapeHtml(item?.preset)}</dd>
        <dt>模型备注（不切换会话）</dt><dd>${escapeHtml(typeof item?.model === 'string' && item.model.length > 0 ? item.model : '会话默认')}</dd>
      </dl>
    </article>`
  }).join('')
}

function journalRows(entries) {
  if (entries.length === 0) return '<li class="empty">还没有工作记录。员工调用 team_log 后会出现在这里。</li>'
  return entries.slice().reverse().map((entry) => {
    const when = typeof entry?.at === 'string' ? entry.at.replace('T', ' ').slice(0, 16) : '?'
    const artifacts = Array.isArray(entry?.artifacts) && entry.artifacts.length > 0
      ? `<div class="artifacts">${entry.artifacts.map((file) => `<code>${escapeHtml(file)}</code>`).join(' ')}</div>`
      : ''
    return `<li><span class="when">${escapeHtml(when)}</span><span class="who">${escapeHtml(entry?.employee)}</span><span class="status">${escapeHtml(entry?.status ?? '进行中')}</span><span class="summary">${escapeHtml(entry?.summary)}</span>${artifacts}</li>`
  }).join('')
}

function pipelineBlock(content) {
  if (content === null) return '<p class="empty">读不到流水线数据。</p>'
  const stages = STAGES
    .filter((stage) => (content.byStage[stage] ?? 0) > 0)
    .map((stage) => `<span class="pill">${escapeHtml(stage)} ${content.byStage[stage]}</span>`)
    .join('')
  const review = content.review.length === 0
    ? '<p class="empty">没有待审条目。</p>'
    : `<ol class="review">${content.review.map((row) => `<li><code>${escapeHtml(row.id)}</code> ${escapeHtml(row.topic)} ${row.total === null ? '' : `分 ${escapeHtml(row.total)}`}</li>`).join('')}</ol>`
  return `
    <p class="meta">共 ${content.total} 条｜成本 ${content.cost.cny} CNY ／ ${content.cost.tokens} tokens｜权重版本 ${content.weights === null ? '还没有样本' : `v${escapeHtml(content.weights.version)}（${escapeHtml(content.weights.samples)} 条）`}</p>
    <p>${stages || '<span class="empty">队列是空的</span>'}</p>
    <h3>待审 ${content.review.length} 条</h3>${review}`
}

function renderPanel(snapshotData, now) {
  const { team, employees, presets, content, journal } = snapshotData
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(team)} · 团队面板</title>
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin: 0; padding: 32px; background: #14161a; color: #e6e8eb;
         font: 14px/1.6 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif }
  h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: .5px }
  h3 { font-size: 13px; margin: 18px 0 8px; color: #cfd6e0 }
  .meta { color: #8b94a3; font-size: 12px; margin-bottom: 20px }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px;
       color: #8b94a3; margin: 32px 0 12px; font-weight: 500 }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)) }
  .card { background: #1c1f25; border: 1px solid #262b33; border-radius: 10px; padding: 14px 16px }
  .card header { display: flex; align-items: baseline; gap: 8px }
  .card .who { font-size: 15px; font-weight: 600 }
  .card .role { font-size: 12px; color: #7aa2f7 }
  .card .warn { font-size: 11px; color: #e0af68; border: 1px solid #3a3320; border-radius: 999px; padding: 0 6px }
  .card p { color: #b6bdc9; margin: 8px 0 10px }
  dl { display: grid; grid-template-columns: 44px 1fr; gap: 2px 10px; margin: 0; font-size: 12px }
  dt { color: #6b7482 } dd { margin: 0; color: #cfd6e0 }
  ol { list-style: none; margin: 0; padding: 0 }
  ol.review li { padding: 4px 0; color: #b6bdc9 }
  li.row { display: grid; grid-template-columns: 110px 70px 60px 1fr; gap: 10px;
       padding: 8px 0; border-bottom: 1px solid #22262d; align-items: baseline }
  .when { color: #6b7482; font-variant-numeric: tabular-nums }
  .who { color: #cfd6e0 }
  .status { color: #9ece6a }
  .summary { color: #b6bdc9 }
  .artifacts { grid-column: 4; color: #7aa2f7; font-size: 12px; margin-top: 4px }
  .pill { display: inline-block; background: #22262d; color: #cfd6e0; border-radius: 999px;
          padding: 1px 10px; margin-right: 6px; font-size: 12px }
  code { background: #242830; padding: 1px 6px; border-radius: 4px }
  .empty { color: #6b7482 }
</style></head><body>
  <h1>${escapeHtml(team)}</h1>
  <div class="meta">花名册：<code>${escapeHtml(snapshotData.paths.roster)}</code> ｜ 日志：<code>${escapeHtml(snapshotData.paths.journal)}</code> ｜ 刷新于 ${escapeHtml(now)}，每 5 秒自动刷新</div>

  <h2>在岗员工 ${employees.length}</h2>
  <section class="grid">${employeeCards(employees, presets)}</section>

  <h2>内容流水线</h2>
  ${pipelineBlock(content)}

  <h2>最近工作</h2>
  <ol>${journalRows(journal)}</ol>
  <script>setTimeout(() => location.reload(), 5000)</script>
</body></html>`
}

// ── 挂载 ──────────────────────────────────────────────────────────────

export function apply(ctx) {
  // 只在 Web 宿主存在时挂面板；没有也不影响员工和工具。
  ctx.inject(['webServer'], (webCtx) => {
    const handler = async (req, res) => {
      // 复用宿主自己的访问校验：浏览器需要先按官方方式打开过 GUI；
      // 桌面端由 Electron 自动带 cookie，直接通过。
      const rejection = webCtx.get('connection')?.requestRejection?.(req)
      if (rejection !== undefined) {
        sendText(res, rejection, '需要先按 DSH 打印的带令牌地址在浏览器打开一次 GUI，本页才可访问。\n')
        return
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const pathname = url.pathname.replace(/\/+$/, '') || '/'
      const method = req.method ?? 'GET'

      try {
        if (pathname === `${PANEL_PATH}/actions`) {
          if (method !== 'POST') { sendText(res, 405, '只支持 POST'); return }
          // Require host authentication and a custom same-origin request header.
          // This is a UI/CSRF boundary, not a sandbox against local shell access.
          const connection = webCtx.get('connection')
          if (typeof connection?.requestRejection !== 'function') { sendText(res, 503, '宿主认证服务不可用'); return }
          const origin = req.headers?.origin
          if (req.headers?.['x-dsh-team-action'] !== 'human' || (origin && origin !== 'dsh-app://app' && origin !== `http://${req.headers?.host}` && origin !== `https://${req.headers?.host}`)) {
            sendText(res, 403, '请从团队面板操作'); return
          }
          const body = await readBody(req)
          const saved = body.action === 'gate'
            ? await decideGate(body.id, { by: body.by, decision: body.decision, note: body.note })
            : body.action === 'publication'
              ? await confirmPublication(body.id, { platform: body.platform, ref: body.ref, by: body.by })
              : null
          if (!saved) throw new Error('未知人工操作')
          sendJson(res, 200, { ok: true, id: saved.id, stage: saved.stage })
          return
        }
        if (pathname === `${PANEL_PATH}/api`) {
          if (method === 'GET') {
            sendJson(res, 200, await snapshot(webCtx))
            return
          }
          if (method === 'POST') {
            const body = await readBody(req)
            const { roster, id } = await mutateRoster(String(body?.action ?? 'upsert'), body?.employee)
            const presets = await presetList(webCtx)
            const employee = roster.employees.find((item) => item.id === id)
            const owned = presets.some((preset) => preset.id === (employee?.preset ?? id))
            sendJson(res, 200, {
              ok: true,
              team: roster.team,
              employees: roster.employees,
              presets,
              ...owned ? {} : {
                warning: `「${employee?.preset ?? id}」还没有对应的工牌（agent preset），新建会话的模式下拉里看不到他。把下面的片段贴进 cordis.patch.yml 再重启：`,
                snippet: presetSnippet(employee ?? { id, preset: id })
              }
            })
            return
          }
          sendText(res, 405, '只支持 GET / POST\n')
          return
        }

        if (pathname === PANEL_PATH) {
          if (method !== 'GET') {
            sendText(res, 405, '只支持 GET\n')
            return
          }
          const html = renderPanel(await snapshot(webCtx), new Date().toLocaleString('zh-CN'))
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(html)
          return
        }

        sendText(res, 404, '没有这个路径。可用：GET /team，GET /team/api，POST /team/api\n')
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    }

    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: PANEL_PATH, handler }),
      'team-employees: /team panel'
    )
  })
}

/** 给新员工生成一段可以贴进 cordis.patch.yml 的工牌样板。 */
function presetSnippet(employee) {
  const id = String(employee?.preset ?? employee?.id ?? 'new-employee')
  const label = String(employee?.name ?? id)
  const role = String(employee?.role ?? '员工')
  return [
    `    - id: preset-employee-${id}`,
    `      name: '@deepseek-ai/dsh-agent-preset'`,
    `      config:`,
    `        id: ${id}`,
    `        name: ${role}·${label}`,
    `        description: 一句话说清他不做什么`,
    `        order: 30`,
    `        plugins:`,
    `          - id: persona`,
    `            name: '@deepseek-ai/dsh-persona'`,
    `            config:`,
    `              prefix: |`,
    `                你是「${label}」，团队里的${role}。只做一件事：……。`,
    `                你不做的事：……。`,
    `              suffix: Your working directory is {{cwd}}.`,
    `          - id: tool-fs`,
    `            name: '@deepseek-ai/dsh-tool-fs'`,
    `          - id: team-tools`,
    `            name: 'dsh-team-employees/tools'`
  ].join('\n')
}
