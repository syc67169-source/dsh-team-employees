import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, timeout = 5000) {
  const at = Date.now()
  while (Date.now() - at < timeout) { if (await check()) return; await delay(20) }
  throw new Error('process acceptance condition timed out')
}
test('actual worker processes: duplicate rejected, killed run recovered, graceful stop leaves durable memory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-research-process-'))
  process.env.DSH_TEAM_ROOT = root
  const store = await import('../lib/research-store.mjs')
  await writeFile(path.join(root, 'employees.json'), JSON.stringify({ employees: [{ id: 'scout', name: 'fixture', role: 'test' }] }))
  const goal = await store.controlResearch({ action: 'create', title: 'Process fixture', objective: 'Test only', employee: 'scout', sources: ['https://example.com/'], dailyLimit: 6 })
  await store.controlResearch({ action: 'enable', id: goal.id })
  const workerUrl = new URL('../lib/research-worker.mjs', import.meta.url).href
  const fixture = path.join(root, 'worker-fixture.mjs')
  await writeFile(fixture, `import { startResearchWorker } from ${JSON.stringify(workerUrl)};
import { writeFile } from 'node:fs/promises';
const controller=new AbortController();process.on('SIGTERM',()=>controller.abort());
await startResearchWorker({signal:controller.signal,tickMs:20,
collect:async url=>({url,hash:'fixture-hash',text:'only fixture evidence',fetchedAt:new Date().toISOString()}),
analyze:async()=>{await writeFile(process.env.DSH_TEAM_ROOT+'/model-started',String(process.pid));if(process.env.FIXTURE_HANG==='1')await new Promise(()=>{});return {summary:'fixture successful durable brief',sessionId:'fixture'};}});`)
  const children = []
  const start = hang => {
    const child = spawn(process.execPath, [fixture], { env: { ...process.env, FIXTURE_HANG: hang ? '1' : '0' }, stdio: ['ignore', 'ignore', 'pipe'] })
    children.push(child)
    child.done = new Promise((resolve, reject) => { let stderr=''; child.stderr.on('data', chunk => { stderr+=chunk }); child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal, stderr })) })
    return child
  }
  try {
    const first = start(true)
    await until(async () => { try { return Number(await readFile(path.join(root, 'model-started'),'utf8')) === first.pid } catch { return false } })
    const second = start(false)
    const duplicate = await second.done
    assert.equal(duplicate.code, 0); assert.equal((await store.readResearch()).worker.pid, first.pid)
    first.kill('SIGKILL'); await first.done
    const restarted = start(false)
    await until(async () => Boolean((await store.readResearch()).goals[0].memory))
    const saved = await store.readResearch()
    assert.equal(saved.goals[0].memory.summary, 'fixture successful durable brief')
    assert.ok(saved.goals[0].runs.some(run => run.status === 'interrupted'))
    assert.equal(saved.goals[0].usage.calls, 2)
    restarted.kill('SIGTERM'); const closed = await restarted.done
    assert.equal(closed.code, 0, closed.stderr)
    assert.equal((await store.readResearch()).worker, null)
    assert.equal((await store.readResearch()).goals[0].enabled, true)
    assert.match(await readFile(saved.goals[0].memory.report,'utf8'), /fixture successful durable brief/)
  } finally {
    for (const child of children) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
    await Promise.all(children.map(child => child.done.catch(()=>{})))
    await rm(root,{recursive:true,force:true})
  }
})
