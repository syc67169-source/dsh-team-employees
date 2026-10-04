import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import http from 'node:http'
const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-research-'))
process.env.DSH_TEAM_ROOT = root
await writeFile(path.join(root, 'employees.json'), JSON.stringify({ employees: [{ id: 'scout', name: '研究员', role: '研究', note: '只读' }] }))
const store = await import('../lib/research-store.mjs')
const { executeResearch, startResearchWorker } = await import('../lib/research-worker.mjs')
const { publicAddress, resolvePublic, visibleText, collectSource, requestSourcePage } = await import('../lib/research-source.mjs')
const { runHeadless } = await import('../lib/research-headless.mjs')
let goal, calls = 0, revision = 'baseline'
const now = Date.parse('2026-10-04T00:00:00Z')
const fixtureSource = async url => ({ url, finalUrl: url, fetchedAt: store.iso(now), hash: createHash('sha256').update(revision).digest('hex'), text: `Fixture source: ${revision}`, truncated: false })
const fixtureModel = async () => { calls++; return { summary: `Fixture brief: ${revision}`, sessionId: 'fixture-session' } }
const create = (title = '持续研究', sources = ['https://example.com/']) => store.controlResearch({ action: 'create', title, objective: '比较资讯变化并列出来源', employee: 'scout', sources, intervalMinutes: 15, dailyLimit: 3 }, now)
async function reset() { await rm(path.join(root, 'research'), { recursive: true, force: true }) }
after(async () => { await rm(root, { recursive: true, force: true }) })

test('source transport bounds responses, reports HTTP failures, redirects and timeouts', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/hang') return
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1/private' }); res.end(); return }
    if (req.url === '/error') { res.writeHead(503); res.end(); return }
    res.writeHead(200, { 'content-type': req.url === '/binary' ? 'image/png' : 'text/plain' })
    res.end('Public evidence fixture '.repeat(20))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  // Only the transport is tested on loopback. The public entry must reject it.
  const address = { address: '127.0.0.1', family: 4 }
  const url = route => new URL(`http://127.0.0.1:${server.address().port}${route}`)
  try {
    assert.match((await requestSourcePage(url('/ok'), address)).body, /evidence fixture/)
    assert.equal((await requestSourcePage(url('/redirect'), address)).redirect, 'http://127.0.0.1/private')
    await assert.rejects(() => requestSourcePage(url('/error'), address), /HTTP 503/)
    await assert.rejects(() => requestSourcePage(url('/binary'), address), /文本/)
    await assert.rejects(() => requestSourcePage(url('/ok'), address, { maxBytes: 10 }), /上限/)
    await assert.rejects(() => requestSourcePage(url('/hang'), address, { timeoutMs: 30 }), /超时/)
    await assert.rejects(() => collectSource('http://127.0.0.1/private'), /私有/)
    await assert.rejects(() => resolvePublic(new URL('https://example.org'), () => new Promise(() => {}), { timeoutMs: 20 }), /DNS.*超时/)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('creation persists paused goal and validates roster, cadence and source scheme', async () => {
  goal = await create()
  assert.equal(goal.status, 'paused'); assert.equal(goal.enabled, false)
  assert.equal((await store.readResearch()).goals[0].objective, goal.objective)
  await assert.rejects(() => create('bad', ['file:///etc/passwd']), /HTTP/)
  await assert.rejects(() => store.controlResearch({ action: 'create', employee: 'missing' }), /花名册/)
  await assert.rejects(() => store.controlResearch({ action: 'create', employee: 'scout', title: 'bad', objective: 'bad', sources: ['https://example.com'], intervalMinutes: 0 }), /执行间隔/)
})
test('exclusive claim prevents parallel workers and manual run does not enable recurring work', async () => {
  await store.controlResearch({ action: 'run-once', id: goal.id }, now)
  const claims = await Promise.all(Array.from({ length: 10 }, () => store.claimResearch('test', now)))
  assert.equal(claims.filter(Boolean).length, 1)
  assert.equal((await store.readResearch()).goals[0].enabled, false)
  goal = claims.find(Boolean)
})
test('baseline yields report+memory, unchanged skips model, changed yields notice and replaces memory', async () => {
  await executeResearch(goal, { collect: fixtureSource, analyze: fixtureModel, now: () => now })
  let saved = (await store.readResearch()).goals[0]
  assert.equal(saved.memory.summary, 'Fixture brief: baseline'); assert.equal(saved.status, 'paused')
  assert.match(await readFile(saved.memory.report, 'utf8'), /首次执行/)
  await store.controlResearch({ action: 'enable', id: goal.id }, now)
  let claimed = await store.claimResearch('test', now)
  await executeResearch(claimed, { collect: fixtureSource, analyze: fixtureModel, now: () => now })
  assert.equal(calls, 1)
  assert.equal((await store.readResearch()).goals[0].runs[0].status, 'unchanged')
  revision = 'new finding'
  claimed = await store.claimResearch('test', now + 15 * 60000)
  await executeResearch(claimed, { collect: fixtureSource, analyze: fixtureModel, now: () => now + 15 * 60000 })
  saved = await store.readResearch()
  assert.equal(calls, 2); assert.equal(saved.notices.filter(row => row.kind === 'change').length, 1)
  assert.equal(saved.goals[0].memory.summary, 'Fixture brief: new finding')
})
test('collection failure preserves baseline, backs off and pauses after three failures', async () => {
  const memory = (await store.readResearch()).goals[0].memory
  let clock = now + 60 * 60000
  for (let i = 0; i < 3; i++) {
    const claimed = await store.claimResearch('test', clock)
    assert.ok(claimed)
    await executeResearch(claimed, { collect: async () => { throw new Error('fixture network error') }, now: () => clock })
    clock += 60 * 60000
  }
  const state = await store.readResearch()
  assert.deepEqual(state.goals[0].memory, memory)
  assert.equal(state.goals[0].status, 'needs-attention'); assert.equal(state.goals[0].enabled, false)
})
test('pause cancels active work and excludes late successful results from memory', async () => {
  await store.controlResearch({ action: 'enable', id: goal.id }, now)
  const claimed = await store.claimResearch('test', now)
  await store.controlResearch({ action: 'pause', id: goal.id }, now)
  const result = await store.finishResearch(goal.id, claimed.active.id, { status: 'success', summary: 'must not become memory', sources: [], changed: ['x'] }, now)
  assert.equal(result.status, 'cancelled')
  assert.equal((await store.readResearch()).goals[0].memory.summary, 'Fixture brief: new finding')
})
test('daily cap prevents model invocation but unchanged sources do not consume budget', async () => {
  await store.controlResearch({ action: 'enable', id: goal.id }, now)
  await store.updateResearch(state => { state.goals[0].usage = { day: '2026-10-04', calls: 3 } })
  revision = 'another update'
  const claimed = await store.claimResearch('test', now)
  await executeResearch(claimed, { collect: fixtureSource, analyze: fixtureModel, now: () => now })
  assert.equal(calls, 2)
  const saved = (await store.readResearch()).goals[0]
  assert.equal(saved.runs[0].status, 'deferred'); assert.equal(saved.nextRunAt, '2026-10-05T00:00:00.000Z')
})
test('interrupted run recovers after dead process; live process cannot be stolen', async () => {
  await store.updateResearch(state => { const g = state.goals[0]; g.active = { id: 'interrupted', pid: 999999, owner: 'dead', startedAt: store.iso(now) }; g.status = 'running' })
  const claimed = await store.claimResearch('restart', now)
  assert.ok(claimed)
  assert.equal((await store.readResearch()).goals[0].runs[0].status, 'interrupted')
  assert.equal(await store.claimResearch('second', now), null)
  await store.finishResearch(goal.id, claimed.active.id, { status: 'cancelled' }, now)
})
test('public resolver rejects localhost, private DNS, mapped IPv6 and mixed answers', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1']) assert.equal(publicAddress(address), false, address)
  assert.equal(publicAddress('93.184.216.34'), true)
  await assert.rejects(() => resolvePublic(new URL('https://example.com'), async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]), /私有/)
  await assert.rejects(() => collectSource('http://127.0.0.1/'), /私有/)
  await assert.rejects(() => collectSource('https://example.com:8443/'), /不允许/)
})
test('normalized evidence excludes scripts, normalizes whitespace and validates JSON', () => {
  assert.equal(visibleText('<h1>Title</h1><script>evil()</script><p>A &amp; B</p>'), 'Title A & B')
  assert.throws(() => visibleText('not-json', 'application/json'))
})
test('headless adapter accepts committed final and handles split UTF-8 output', async () => {
  const script = path.join(root, 'fixture-headless.mjs')
  await writeFile(script, `process.stdin.resume();process.stdin.on('end',()=>{const bytes=Buffer.from(JSON.stringify({type:'session',sessionId:'fixture'})+'\\n'+JSON.stringify({type:'status',phase:'turn_end',reason:{kind:'completed'}})+'\\n'+JSON.stringify({type:'final',text:'中文简报'})+'\\n');for(const byte of bytes)process.stdout.write(Buffer.from([byte]));})`)
  const result = await runHeadless(goal, [], { command: { executable: process.execPath, args: [script] }, timeoutMs: 1000 })
  assert.equal(result.summary, '中文简报'); assert.equal(result.sessionId, 'fixture')
})
test('headless adapter rejects failed/empty/malformed final and kills on timeout', async () => {
  const script = path.join(root, 'bad-headless.mjs')
  for (const reason of [null, { kind: 'cancelled' }]) {
    await writeFile(script, `console.log(JSON.stringify({type:'session',sessionId:'x'}));console.log(JSON.stringify({type:'final',text:'uncommitted'}));${reason ? `console.log(JSON.stringify({type:'status',phase:'turn_end',reason:${JSON.stringify(reason)}}))` : ''}`)
    await assert.rejects(() => runHeadless(goal, [], { command: { executable: process.execPath, args: [script] }, timeoutMs: 1000 }), /未完成/)
  }
  for (const code of [`console.log('not-json')`, `console.log(JSON.stringify({type:'final',text:'misleading'}));process.exit(1)`, `console.log(JSON.stringify({type:'session',sessionId:'x'}));console.log(JSON.stringify({type:'final',text:''}))`]) {
    await writeFile(script, code)
    await assert.rejects(() => runHeadless(goal, [], { command: { executable: process.execPath, args: [script] }, timeoutMs: 1000 }), /未完成/)
  }
  await writeFile(script, `setInterval(()=>{},1000);process.stdin.resume()`)
  await assert.rejects(() => runHeadless(goal, [], { command: { executable: process.execPath, args: [script] }, timeoutMs: 30 }), /超过/)
})
test('worker persists lifecycle and ignores paused responsibilities', async () => {
  await store.controlResearch({ action: 'pause', id: goal.id })
  const abort = new AbortController()
  const running = startResearchWorker({ signal: abort.signal, tickMs: 10, collect: fixtureSource, analyze: fixtureModel })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal((await store.researchOverview()).worker.online, true)
  abort.abort(); await running
  assert.equal((await store.researchOverview()).worker.online, false)
  assert.equal(calls, 2)
})
