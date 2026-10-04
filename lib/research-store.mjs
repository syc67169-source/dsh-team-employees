import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { teamRoot, readRoster } from './store.mjs'
import { withFileLock, writeJsonAtomic } from './storage.mjs'

export const researchFile = () => path.join(teamRoot(), 'research', 'state.json')
export const researchRoot = () => path.dirname(researchFile())
export const iso = value => new Date(value).toISOString()
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}
export async function readResearch() {
  try { return JSON.parse(await readFile(researchFile(), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return { schema: 1, goals: [], notices: [], worker: null }; throw error }
}
export async function updateResearch(fn) {
  return withFileLock(researchFile(), async () => {
    const state = await readResearch()
    const result = await fn(state)
    await writeJsonAtomic(researchFile(), state)
    return result
  })
}
function text(value, label, max = 1000) {
  const input = String(value ?? '').trim()
  if (!input || input.length > max) throw new Error(`${label}必填，最多 ${max} 字`)
  return input
}
export function sourceUrls(value) {
  const rows = Array.isArray(value) ? value : String(value ?? '').split(/\s+/)
  const urls = [...new Set(rows.filter(Boolean).map(raw => {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname || (url.port && !['80', '443'].includes(url.port))) throw new Error('来源仅允许无登录信息的 HTTP/HTTPS 标准端口网址')
    url.hash = ''
    if (url.href.length > 2000) throw new Error('来源网址过长')
    return url.href
  }))]
  if (!urls.length || urls.length > 5) throw new Error('需要 1–5 个来源网址')
  return urls
}
function goalOf(state, id) {
  const goal = state.goals.find(row => row.id === id)
  if (!goal) throw new Error('没有这个长期职责')
  return goal
}
export function notice(state, goal, kind, message, at) {
  state.notices.push({ id: randomUUID(), goalId: goal.id, kind, message, at: iso(at), read: false })
  state.notices = state.notices.slice(-50)
}
export async function controlResearch(input, now = Date.now()) {
  if (input.action === 'create') {
    const roster = await readRoster()
    if (!roster.employees.some(row => row.id === input.employee)) throw new Error('请选择花名册中的员工')
    const title = text(input.title, '职责名称', 100)
    const objective = text(input.objective, '长期目标', 2000)
    const sources = sourceUrls(input.sources)
    const intervalMinutes = Number(input.intervalMinutes ?? 60)
    const dailyLimit = Number(input.dailyLimit ?? 6)
    if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 15 || intervalMinutes > 10080) throw new Error('执行间隔为 15–10080 分钟整数')
    if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 24) throw new Error('每日模型唤醒上限为 1–24 次')
    return updateResearch(state => {
      if (state.goals.length >= 10) throw new Error('第一版最多保存 10 个职责，且仅支持一个启用的职责')
      const employee = roster.employees.find(row => row.id === input.employee)
      const goal = { employeeContext: { name: employee.name, role: employee.role, note: employee.note }, id: randomUUID(), title, objective, employee: input.employee, sources, intervalMinutes, dailyLimit,
        enabled: false, status: 'paused', createdAt: iso(now), updatedAt: iso(now), nextRunAt: null,
        active: null, manualPending: false, cancelRequested: false, failures: 0, usage: { day: '', calls: 0 }, memory: null, runs: [] }
      state.goals.push(goal); return goal
    })
  }
  return updateResearch(state => {
    if (input.action === 'read-notices') { state.notices.forEach(row => { row.read = true }); return { ok: true } }
    const goal = goalOf(state, input.id)
    if (input.action === 'pause') {
      goal.enabled = false; goal.manualPending = false; goal.cancelRequested = true
      goal.status = goal.active ? 'cancelling' : 'paused'; goal.nextRunAt = null
    } else if (['enable', 'run-once'].includes(input.action)) {
      if (goal.active) throw new Error('这个职责正在执行，请先等待或暂停')
      if (state.goals.some(row => row.id !== goal.id && (row.enabled || row.active || row.manualPending))) throw new Error('第一版一次只运行一个职责，请先暂停其他职责')
      goal.cancelRequested = false; goal.failures = 0
      if (input.action === 'enable') goal.enabled = true
      else goal.manualPending = true
      goal.status = 'scheduled'; goal.nextRunAt = iso(now)
    } else throw new Error('未知长期职责操作')
    goal.updatedAt = iso(now); return goal
  })
}
export async function claimResearch(owner, now = Date.now()) {
  return updateResearch(state => {
    for (const goal of state.goals) {
      if (goal.active && !processAlive(goal.active.pid)) {
        if (goal.active.once && !goal.cancelRequested) goal.manualPending = true
        goal.runs.unshift({ ...goal.active, status: 'interrupted', finishedAt: iso(now), error: '上次进程异常退出，未将未完成内容记为成功' })
        goal.runs = goal.runs.slice(0, 20); goal.active = null
        goal.failures++
        if (goal.failures >= 3) { goal.enabled = false; goal.manualPending = false; notice(state, goal, 'attention', '连续中断，已暂停；请检查本地后台后重新启用。', now) }
        goal.status = goal.enabled || goal.manualPending ? 'scheduled' : goal.failures >= 3 ? 'needs-attention' : 'paused'
        goal.nextRunAt = goal.enabled || goal.manualPending ? iso(now) : null
      }
    }
    if (state.goals.some(goal => goal.active)) return null
    const goal = state.goals.find(row => (row.enabled || row.manualPending) && row.nextRunAt && Date.parse(row.nextRunAt) <= now)
    if (!goal) return null
    goal.active = { id: randomUUID(), owner, pid: process.pid, once: goal.manualPending, startedAt: iso(now) }
    goal.cancelRequested = false; goal.status = 'running'; goal.manualPending = false
    return structuredClone(goal)
  })
}
export async function admitModel(id, runId, now = Date.now()) {
  return updateResearch(state => {
    const goal = goalOf(state, id)
    if (goal.active?.id !== runId || goal.cancelRequested) throw new Error('执行已取消或归属已变更')
    const day = iso(now).slice(0, 10)
    if (goal.usage.day !== day) goal.usage = { day, calls: 0 }
    if (goal.usage.calls >= goal.dailyLimit) return false
    goal.usage.calls++; return true
  })
}
export async function finishResearch(id, runId, result, now = Date.now()) {
  return updateResearch(state => {
    const goal = goalOf(state, id)
    if (goal.active?.id !== runId) return null
    const cancelled = goal.cancelRequested || result.status === 'cancelled'
    const run = { ...goal.active, ...result, status: cancelled ? 'cancelled' : result.status, finishedAt: iso(now) }
    goal.active = null; goal.cancelRequested = false
    const { sources, summary, ...history } = run
    goal.runs.unshift({ ...history, excerpt: summary?.slice(0, 240) }); goal.runs = goal.runs.slice(0, 20); goal.updatedAt = iso(now)
    if (run.status === 'success') {
      goal.memory = { summary: result.summary.slice(0, 6000), sources: result.sources.map(({ text, ...source }) => source), at: iso(now), runId, report: result.report }
      goal.failures = 0
      if (result.changed?.length) notice(state, goal, 'change', `${result.changed.length} 个来源出现变化：${goal.title}`, now)
    } else if (run.status === 'failed') {
      goal.failures++
      notice(state, goal, 'error', `${goal.title}：${result.error}`, now)
      if (goal.failures >= 3) { goal.enabled = false; notice(state, goal, 'attention', '连续 3 次失败，已暂停。请检查来源/模型配置后重新启用。', now) }
    }
    if (run.status === 'deferred') {
      goal.nextRunAt = goal.enabled ? iso(Date.parse(iso(now).slice(0, 10) + 'T00:00:00Z') + 86400000) : null
      notice(state, goal, 'attention', `${goal.title}：今日模型唤醒次数已达上限，${goal.enabled ? '推迟到明日（UTC）' : '明日（UTC）可再次手动执行'}`, now)
    } else goal.nextRunAt = goal.enabled ? iso(now + (run.status === 'failed' ? Math.min(60, 5 * 2 ** (goal.failures - 1)) : goal.intervalMinutes) * 60000) : null
    goal.status = goal.enabled ? 'scheduled' : goal.failures >= 3 ? 'needs-attention' : 'paused'
    return run
  })
}
export async function researchOverview() {
  const state = await readResearch()
  return { ...state, worker: state.worker ? { ...state.worker, online: processAlive(state.worker.pid) && Date.now() - Date.parse(state.worker.at) < 15000 } : { online: false } }
}
