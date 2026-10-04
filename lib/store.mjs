// 团队数据的唯一读写入口：花名册 + 共享工作日志。
// 刻意只用 node 内置模块，避免依赖 @deepseek-ai/* 的版本（运行时是 0.2.0-rc.2，
// npm 上同名包的版本对不上，import 进来只会踩坑）。

import { appendFile, mkdir, readFile, open } from 'node:fs/promises'
import os from 'node:os'
import { withFileLock } from './storage.mjs'
import path from 'node:path'

/** DSH 主目录：优先环境变量，其次 ~/.dsh */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 团队数据根目录：默认 $DSH_HOME/team，可用 DSH_TEAM_ROOT 覆盖 */
export function teamRoot() {
  return process.env.DSH_TEAM_ROOT || path.join(dshHome(), 'team')
}

export function rosterPath() {
  return path.join(teamRoot(), 'employees.json')
}

export function journalPath() {
  return path.join(teamRoot(), 'journal.jsonl')
}

/** 读花名册。文件不存在时返回空队伍，而不是抛错。 */
export async function readRoster() {
  try {
    const parsed = JSON.parse(await readFile(rosterPath(), 'utf8'))
    const employees = Array.isArray(parsed?.employees) ? parsed.employees : []
    return {
      team: typeof parsed?.team === 'string' && parsed.team.length > 0 ? parsed.team : '我的 AI 团队',
      employees
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { team: '我的 AI 团队', employees: [] }
    throw error
  }
}

/** 追加一条工作记录。任何人（员工或用户）都可以写。 */
export async function appendJournal(entry) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`
  await mkdir(teamRoot(), { recursive: true })
  await withFileLock(journalPath(), () => appendFile(journalPath(), line, 'utf8'))
  return line.trim()
}

/** 读最近 limit 条工作记录，返回时间正序。 */
export async function readJournal(limit = 20) {
  const size = Number.isSafeInteger(limit) && limit > 0 ? limit : 20
  let handle
  try { handle = await open(journalPath(), 'r') }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const entries = []
  try {
    let position = (await handle.stat()).size
    let remainder = ''
    // Scan backwards in bounded chunks; stop once the requested tail is read.
    while (position > 0 && entries.length < size) {
      const length = Math.min(65536, position)
      position -= length
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, position)
      // Keep bytes until complete lines are available (UTF-8 may cross chunks).
      const combined = Buffer.concat([buffer, Buffer.from(remainder, 'latin1')])
      const lines = combined.toString('latin1').split('\n')
      remainder = position > 0 ? lines.shift() : ''
      for (let i = lines.length - 1; i >= 0 && entries.length < size; i--) {
        try { entries.push(JSON.parse(Buffer.from(lines[i], 'latin1').toString('utf8'))) } catch { /* skip partial lines */ }
      }
    }
  } finally { await handle.close() }
  return entries.reverse()

}

/** 把花名册渲染成模型/人都能读的多行文本。 */
export function formatRoster(roster, filter) {
  const wanted = typeof filter === 'string' && filter.trim().length > 0 ? filter.trim() : null
  const rows = wanted === null
    ? roster.employees
    : roster.employees.filter((item) => item?.id === wanted || item?.name === wanted)
  if (rows.length === 0) {
    return wanted === null
      ? `团队「${roster.team}」还没有员工。花名册：${rosterPath()}`
      : `花名册里没有 id 或名字为「${wanted}」的员工。花名册：${rosterPath()}`
  }
  const lines = rows.map((item) => {
    const model = typeof item?.model === 'string' && item.model.length > 0 ? item.model : '（用会话默认模型）'
    const note = typeof item?.note === 'string' ? ` ${item.note}` : ''
    return `- ${item?.name ?? '未命名'}（id: ${item?.id ?? '?'}，模式: ${item?.preset ?? '?'}）｜岗位：${item?.role ?? '未定义'}｜模型备注（不切换会话）：${model}${note}`
  })
  return [`团队「${roster.team}」共 ${roster.employees.length} 人：`, ...lines].join('\n')
}

/** 把工作记录渲染成多行文本。 */
export function formatJournal(entries) {
  if (entries.length === 0) return `工作日志还是空的。日志文件：${journalPath()}`
  return entries.map((entry) => {
    const when = typeof entry?.at === 'string' ? entry.at.replace('T', ' ').slice(0, 16) : '?'
    const who = entry?.employee ?? '未知'
    const status = entry?.status ?? '进行中'
    const artifacts = Array.isArray(entry?.artifacts) && entry.artifacts.length > 0
      ? `｜产出：${entry.artifacts.join('、')}`
      : ''
    return `${when}｜${who}｜${status}｜${entry?.summary ?? ''}${artifacts}`
  }).join('\n')
}
