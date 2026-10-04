import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdir } from 'node:fs/promises'
import { readResearch, updateResearch, claimResearch, finishResearch, admitModel, researchRoot, processAlive, iso } from './research-store.mjs'
import { collectSource, compareSources } from './research-source.mjs'
import { runHeadless } from './research-headless.mjs'
import { writeJsonAtomic, writeTextAtomic } from './storage.mjs'

export async function executeResearch(goal, { collect = collectSource, analyze = runHeadless, signal, now = () => Date.now() } = {}) {
  const runId = goal.active.id
  try {
    const sources = []
    for (const url of goal.sources) {
      signal?.throwIfAborted()
      sources.push(await collect(url, { signal }))
    }
    const changed = compareSources(goal.memory?.sources, sources)
    const same = goal.memory && sources.every(row => goal.memory.sources.some(previous => previous.url === row.url && previous.hash === row.hash))
    if (same) return finishResearch(goal.id, runId, { status: 'unchanged', changed: [], sourceCount: sources.length }, now())
    if (!await admitModel(goal.id, runId, now())) return finishResearch(goal.id, runId, { status: 'deferred', error: '每日模型唤醒上限已达' }, now())
    const folder = path.join(researchRoot(), 'runs', goal.id, runId)
    await mkdir(folder, { recursive: true })
    const result = await analyze(goal, sources, { signal, cwd: folder })
    signal?.throwIfAborted()
    if (!result?.summary?.trim()) throw new Error('模型没有返回可验收的简报')
    const snapshot = { goal: { id: goal.id, title: goal.title, objective: goal.objective, employee: goal.employee }, at: iso(now()), sources, changed, ...result }
    await writeJsonAtomic(path.join(folder, 'result.json'), snapshot)
    const report = path.join(folder, 'report.md')
    const md = `# ${goal.title.replace(/[\r\n]/g, ' ')}\n\n执行时间：${snapshot.at}\n\n${result.summary}\n\n## 来源记录\n\n${sources.map(row => `- ${row.url}（读取：${row.fetchedAt}；SHA256：${row.hash}；${row.truncated ? '模型输入已截断' : '完整文本'}）`).join('\n')}\n\n${goal.memory ? `变化来源：${changed.length} 个` : '首次执行：建立比较基线'}\n`
    await writeTextAtomic(report, md)
    return finishResearch(goal.id, runId, { status: 'success', ...result, sources, changed, report, sourceCount: sources.length }, now())
  } catch (error) {
    return finishResearch(goal.id, runId, { status: signal?.aborted ? 'cancelled' : 'failed', error: signal?.aborted ? '执行已停止，保留上次成功结果' : String(error.message ?? error).slice(0, 500) }, now())
  }
}
export async function startResearchWorker({ signal, tickMs = 5000, collect, analyze } = {}) {
  const external = signal
  const lifecycle = new AbortController()
  const abort = () => lifecycle.abort()
  external?.addEventListener('abort', abort, { once: true })
  if (external?.aborted) abort()
  signal = lifecycle.signal
  const owner = randomUUID()
  const accepted = await updateResearch(state => {
    if (state.worker && processAlive(state.worker.pid)) return false
    state.worker = { id: owner, pid: process.pid, at: iso(Date.now()), startedAt: iso(Date.now()) }; return true
  })
  if (!accepted) { external?.removeEventListener('abort', abort); return { alreadyRunning: true } }
  let active = null, heartbeatPending = false
  const heartbeat = async () => {
    if (heartbeatPending) return
    heartbeatPending = true
    try {
      const state = await readResearch()
      if (state.worker?.id !== owner || state.worker.stopRequested) { lifecycle.abort(); active?.abort(); return }
      if (active && state.goals.some(goal => goal.active?.owner === owner && goal.cancelRequested)) active.abort()
      await updateResearch(current => { if (current.worker?.id === owner) current.worker.at = iso(Date.now()) })
    } finally { heartbeatPending = false }
  }
  const timer = setInterval(() => { heartbeat().catch(() => { active?.abort() }) }, 2000)
  try {
    while (!signal?.aborted) {
      const state = await readResearch()
      if (state.worker?.id !== owner) break
      const goal = await claimResearch(owner)
      if (goal) {
        active = new AbortController()
        const stop = () => active?.abort()
        signal?.addEventListener('abort', stop, { once: true })
        try { await executeResearch(goal, { collect, analyze, signal: active.signal }) }
        finally { signal?.removeEventListener('abort', stop); active = null }
      }
      await delay(tickMs, undefined, { signal }).catch(error => { if (!signal?.aborted) throw error })
    }
  } finally {
    clearInterval(timer)
    external?.removeEventListener('abort', abort)
    // Let a heartbeat finish before marking this owner offline.
    while (heartbeatPending) await delay(10)
    await updateResearch(state => { if (state.worker?.id === owner) state.worker = null })
  }
  return { stopped: true }
}
