import { spawn } from 'node:child_process'
import { access, mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { teamRoot } from './store.mjs'
import { researchOverview, researchRoot } from './research-store.mjs'
const worker = fileURLToPath(new URL('../bin/research-worker.mjs', import.meta.url))
let launching = null
async function nodeExecutable() {
  if (process.env.DSH_TEAM_NODE) { await access(process.env.DSH_TEAM_NODE); return process.env.DSH_TEAM_NODE }
  if (!process.versions.electron) return process.execPath
  for (const folder of [...(process.env.PATH ?? '').split(path.delimiter), ...process.platform === 'darwin' ? ['/usr/local/bin', '/opt/homebrew/bin'] : []]) {
    const file = path.join(folder, process.platform === 'win32' ? 'node.exe' : 'node')
    try { await access(file); return file } catch {}
  }
  throw new Error('研究后台需要 Node.js 20+；请设置 DSH_TEAM_NODE 为可执行文件路径')
}
export async function ensureResearchWorker() {
  if (launching) return launching
  launching = (async () => {
    const state = await researchOverview()
    if (state.worker.online) return
    // Do not interrupt a possibly busy live owner merely because its heartbeat is late.
    if (state.worker.pid) { try { process.kill(state.worker.pid, 0); return } catch {} }
    const executable = await nodeExecutable()
    await mkdir(researchRoot(), { recursive: true })
    const log = await open(path.join(researchRoot(), 'worker.log'), 'a', 0o600)
    try {
      const child = spawn(executable, [worker, '--root', teamRoot()], { detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      child.unref()
    } finally { await log.close() }
  })()
  try { return await launching } finally { launching = null }
}
