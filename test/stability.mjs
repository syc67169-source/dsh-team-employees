import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, appendFile, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { test, after } from 'node:test'
import { Readable } from 'node:stream'

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-team-stability-'))
process.env.DSH_TEAM_ROOT = root
process.env.DSH_TEAM_CONTENT_ROOT = path.join(root, 'content')
process.env.DSH_TEAM_METRICS_ROOT = path.join(root, 'metrics')
process.env.DSH_USAGE_PATH = path.join(root, 'usage.json')
const content = await import('../lib/content.mjs')
const { withFileLock, writeJsonAtomic } = await import('../lib/storage.mjs')
const store = await import('../lib/store.mjs')
const tools = []
;(await import('../lib/content-tools.js')).apply({ tools: { register: tool => tools.push(tool), guard: () => {} } })
const tool = name => tools.find(row => row.name === name)
let handler
const services = { connection: { requestRejection: () => undefined } }
const ctx = { get: name => services[name], effect: fn => fn(), webServer: { register: route => { handler = route.handler } } }
;(await import('../lib/index.js')).apply({ inject: (_, fn) => fn(ctx) })
async function call(url, body, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  Object.assign(req, { method: 'POST', url, headers })
  let status, raw
  await handler(req, { writeHead: value => { status = value }, end: value => { raw = value } })
  return { status, raw }
}
const human = { 'x-dsh-team-action': 'human', origin: 'dsh-app://app' }
async function published(id) {
  let item = await content.createItem({ id, topic: id })
  item = await content.saveItem(item, { to: 'review' })
  await content.decideGate(id, { by: 'test', decision: 'approve' })
  await tool('content_publish').execute({ id, platform: 'douyin', account: '@test' })
  await content.confirmPublication(id, { platform: 'douyin', ref: 'test-publication', by: 'test' })
}
function worker(code) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', code], { env: process.env })
    let errors = ''
    proc.stderr.on('data', chunk => { errors += chunk })
    proc.on('error', reject)
    proc.on('exit', code => code === 0 ? resolve() : reject(new Error(errors)))
  })
}
after(async () => { await rm(root, { recursive: true, force: true }) })

test('same-process 30 concurrent cost updates retain every amount and token', async () => {
  await content.createItem({ id: 'cost-test', topic: 'cost' })
  await Promise.all(Array.from({ length: 30 }, () => content.addCost('cost-test', { cny: 1, tokens: 10 })))
  const item = await content.readItem('cost-test')
  assert.equal(item.cost.cny, 30); assert.equal(item.cost.tokens, 300)
})
test('four real processes serialize read-modify-write and preserve totals', async () => {
  const url = new URL('../lib/content.mjs', import.meta.url).href
  await Promise.all(Array.from({ length: 4 }, () => worker(`import { addCost } from ${JSON.stringify(url)}; for(let i=0;i<10;i++) await addCost('cost-test',{cny:1,tokens:10})`)))
  const item = await content.readItem('cost-test')
  assert.equal(item.cost.cny, 70); assert.equal(item.cost.tokens, 700)
})
test('stale revision cannot overwrite newer state or newer cost', async () => {
  const stale = await content.readItem('cost-test')
  await content.addCost(stale.id, { cny: 1 })
  await assert.rejects(() => content.saveItem(stale, { to: 'killed', expect: stale.stage }), /版本冲突/)
  assert.equal((await content.readItem(stale.id)).cost.cny, 71)
})
test('parallel creation allocates unique sequence numbers; explicit duplicates fail', async () => {
  const items = await Promise.all(Array.from({ length: 20 }, () => content.createItem({ topic: 'same' })))
  assert.equal(new Set(items.map(row => row.id)).size, 20)
  await assert.rejects(() => content.createItem({ id: items[0].id }), /已存在/)
})
test('legacy historical index is deduplicated before stage filtering', async () => {
  const item = await content.createItem({ id: 'queue-test' })
  await appendFile(content.indexPath(), JSON.stringify({ id: item.id, stage: 'review' }) + '\n' + JSON.stringify({ id: item.id, stage: 'queued' }) + '\n')
  assert.equal((await content.listQueue()).some(row => row.id === item.id), false)
  await content.appendIndex({ ...item, stage: 'queued' })
  const rows = await content.readIndex()
  assert.equal(rows.filter(row => row.id === item.id).length, 1)
})
test('over 200 indexed items are included in full totals', async () => {
  const rows = Array.from({ length: 225 }, (_, i) => ({ id: `count-${i}`, stage: 'ingested', updatedAt: '' }))
  const existing = await readFile(content.indexPath(), 'utf8')
  await appendFile(content.indexPath(), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  assert.ok((await content.listQueue({ stage: null, limit: null })).length >= 225)
  await writeFile(content.indexPath(), existing)
})
test('publication preparation keeps queued, allows multiple platforms; confirmation and metrics validate platform', async () => {
  await published('publication-test')
  await tool('content_publish').execute({ id: 'publication-test', platform: 'tiktok', account: '@test' })
  assert.equal((await content.readItem('publication-test')).targets.length, 2)
  await assert.rejects(() => content.recordMetrics('publication-test', { platform: 'tiktok', views: 1 }), /尚未确认/)
  await assert.rejects(() => content.recordMetrics('publication-test', { platform: 'douyin', views: 1.5 }), /非负整数/)
  await content.confirmPublication('publication-test', { platform: 'tiktok', ref: 'test-2', by: 'test' })
  await Promise.all(['douyin', 'tiktok'].map(platform => content.recordMetrics('publication-test', { platform, views: 10 })))
  assert.equal((await content.readMetrics('publication-test')).outcome.viewsTotal, 20)
  await assert.rejects(() => content.confirmPublication('publication-test', { platform: 'douyin', ref: 'test', by: 'test' }), /重复确认/)
})
test('concurrent weight refresh versions are not lost', async () => {
  await Promise.all(Array.from({ length: 10 }, () => content.refreshWeights({ minSamples: 1 })))
  assert.equal((await content.readWeights()).version, 10)
})
test('30 concurrent roster additions persist and exact route rejects nested API', async () => {
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => call('/team/api', { action: 'upsert', employee: { id: `employee-${i}`, name: `test-${i}`, role: 'test' } })))
  assert.ok(results.every(row => row.status === 200))
  assert.equal((await store.readRoster()).employees.length, 30)
  assert.equal((await call('/team/fake/api', {})).status, 404)
})
test('human routes reject missing header, foreign origin, missing host auth, and authenticated rejection', async () => {
  assert.equal((await call('/team/actions', {})).status, 403)
  assert.equal((await call('/team/actions', {}, { ...human, origin: 'https://evil.test' })).status, 403)
  services.connection = undefined
  assert.equal((await call('/team/actions', {}, human)).status, 503)
  services.connection = { requestRejection: () => 401 }
  assert.equal((await call('/team/actions', {}, human)).status, 401)
  services.connection = { requestRejection: () => undefined }
})
test('human route records review and real publication; business validation errors are reported', async () => {
  const item = await content.createItem({ id: 'human-test' })
  await content.saveItem(item, { to: 'review' })
  assert.equal((await call('/team/actions', { action: 'gate', id: item.id, by: 'test', decision: 'approve' }, human)).status, 200)
  await tool('content_publish').execute({ id: item.id, platform: 'douyin', account: '@test' })
  assert.equal((await call('/team/actions', { action: 'publication', id: item.id, by: 'test', platform: 'douyin', ref: '' }, human)).status, 400)
  assert.equal((await call('/team/actions', { action: 'publication', id: item.id, by: 'test', platform: 'douyin', ref: 'record-123' }, human)).status, 200)
  assert.equal((await content.readItem(item.id)).stage, 'published')
})
test('large UTF-8 journal tail returns last records without scanning entire history', async () => {
  for (let i = 0; i < 40; i++) await store.appendJournal({ summary: `${i} 中文` + '甲'.repeat(3000) })
  await appendFile(store.journalPath(), 'broken-partial-line')
  const rows = await store.readJournal(3)
  assert.equal(rows.length, 3); assert.ok(rows[0].summary.startsWith('37 中文')); assert.ok(rows[2].summary.startsWith('39 中文'))
})
test('unique temporary files never collide; thrown work releases locks', async () => {
  const target = path.join(root, 'atomic.json')
  await Promise.all(Array.from({ length: 40 }, (_, i) => writeJsonAtomic(target, { i })))
  assert.equal(typeof JSON.parse(await readFile(target, 'utf8')).i, 'number')
  await assert.rejects(() => withFileLock(target, () => { throw new Error('test-failure') }), /test-failure/)
  await withFileLock(target, async () => {})
})
test('abandoned lock fails safely without stealing an unrelated or live lock', async () => {
  const target = path.join(root, 'abandoned.json')
  await mkdir(`${target}.lock`)
  await writeFile(path.join(`${target}.lock`, 'owner.json'), JSON.stringify({ pid: 999999, token: 'test' }))
  await assert.rejects(() => withFileLock(target, async () => { assert.fail('must not enter') }, { timeoutMs: 20 }), /等待数据锁超时/)
  assert.equal(JSON.parse(await readFile(path.join(`${target}.lock`, 'owner.json'), 'utf8')).token, 'test')
})
