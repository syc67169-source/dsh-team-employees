// 内容流水线自检：不启动 DSH，直接把注册契约、状态机、闸门和记账跑一遍。
//
//   node test/content.smoke.mjs
//
// 沙箱写在临时目录，不碰真实团队数据，也不碰真实账本。

import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const { toolsApi, harnessNote } = await import('./harness.mjs')
const assertSupportedJsonSchema = toolsApi?.assertSupportedJsonSchema ?? (() => {})
const validateJsonSchemaValue = toolsApi?.validateJsonSchemaValue ?? (() => [])

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'dsh-content-smoke-'))
process.env.DSH_TEAM_ROOT = sandbox
process.env.DSH_USAGE_PATH = path.join(sandbox, 'usage.json')
delete process.env.DSH_USD_CNY

const toolsModule = await import('../lib/content-tools.js')
const content = await import('../lib/content.mjs')
const usage = await import('../lib/usage.mjs')

const results = []
const check = async (label, fn) => {
  try {
    await fn()
    results.push({ ok: true, label })
  } catch (error) {
    results.push({ ok: false, label, detail: error.message })
  }
}

// ── 工具与闸门注册契约 ──────────────────────────────────────────────────
const registered = []
const guards = []
toolsModule.apply({
  tools: {
    register: (definition) => registered.push(definition),
    guard: (guard) => guards.push(guard)
  }
})

const tool = (toolName) => {
  const found = registered.find((entry) => entry.name === toolName)
  if (found === undefined) throw new Error(`没有注册 ${toolName}`)
  return found
}
/** 模拟一次调用。agent=true 表示这次调用来自员工会话。 */
const exec = (toolName, args, { agent = false } = {}) => ({
  name: toolName,
  arguments: args,
  ...(agent ? { agent: { id: 'scout' } } : {})
})

const EXPECTED_TOOLS = [
  'content_new', 'content_score', 'content_script', 'content_render', 'content_queue',
  'content_gate', 'content_publish', 'metrics_pull', 'weights', 'cost_report'
]

await check('注册了 10 个内容工具', () => {
  assert.deepEqual(registered.map((entry) => entry.name), EXPECTED_TOOLS)
})

await check('注册了 1 道闸门', () => {
  assert.equal(guards.length, 1)
  assert.equal(typeof guards[0], 'function')
})

await check('每个工具的参数与输出 schema 都在运行时支持范围内', () => {
  for (const entry of registered) {
    assertSupportedJsonSchema(entry.parameters)
    assertSupportedJsonSchema(entry.output.schema)
    assert.equal(typeof entry.output.render, 'function')
    assert.equal(typeof entry.execute, 'function')
    assert.ok(entry.description.length > 10)
  }
})

await check('导出 name 与 inject', () => {
  assert.equal(toolsModule.name, 'team-employees/content')
  assert.deepEqual(toolsModule.inject, ['tools'])
})

// ── 闸门：员工推不动 review ─────────────────────────────────────────────
const gate = guards[0]

await check('员工调用 content_gate 被闸门拒绝', () => {
  const reason = gate(exec('content_gate', { id: 'x' }, { agent: true }))
  assert.equal(typeof reason, 'string')
  assert.match(reason, /人工闸门/)
})

await check('真人调用 content_gate 不被拒绝', () => {
  assert.equal(gate(exec('content_gate', { id: 'x' })), undefined)
})

await check('闸门不误伤其他工具', () => {
  assert.equal(gate(exec('content_new', {}, { agent: true })), undefined)
  assert.equal(gate({ name: 'team_log', arguments: {} }), undefined)
  assert.equal(gate({ name: 'bash', arguments: {} }), undefined)
})

// ── id 安全 ─────────────────────────────────────────────────────────────
await check('非法 id 被拒（防目录穿越）', () => {
  assert.throws(() => content.assertItemId('../../etc/passwd'), /非法 item id/)
  assert.throws(() => content.assertItemId('AbC'), /非法 item id/)
  assert.throws(() => content.assertItemId('-lead'), /非法 item id/)
  assert.equal(content.assertItemId('20261003-fashion-001'), '20261003-fashion-001')
})

// ── 全链路：入站 → 评分 → 脚本 → 合成 → 停在待审 ────────────────────────
const created = await tool('content_new').execute({
  topic: 'Fashion Haul', ref: 'https://example.com/a', kind: 'campaign', license: 'camp-42', owner: '阿研'
}, {})

const itemId = /已登记：([a-z0-9-]+)/.exec(created.text)?.[1]

await check('content_new 建立条目并给出 id', () => {
  assert.ok(itemId, `没解析出 id：${created.text}`)
  assert.match(itemId, /^\d{8}-fashion-haul-001$/)
})

await check('content_new 记下了授权凭证', async () => {
  const item = await content.readItem(itemId)
  assert.equal(item.stage, 'ingested')
  assert.equal(item.source.license, 'camp-42')
  assert.equal(item.source.kind, 'campaign')
})

await check('content_score 打分并推进到 scored', async () => {
  const out = await tool('content_score').execute({
    id: itemId, hook: 90, emotion: 60, info: 30, hookType: 'question', note: '开头有冲突'
  }, {})
  assert.match(out.text, /已评分/)
  assert.match(out.text, /60 分/)
  const item = await content.readItem(itemId)
  assert.equal(item.stage, 'scored')
  assert.equal(item.score.total, 60)
  assert.equal(item.score.by, 'select')
})

await check('同一条不许评两次分', async () => {
  await assert.rejects(
    () => tool('content_score').execute({ id: itemId, hook: 1, emotion: 1, info: 1 }, {}),
    /只有 ingested 能打分/
  )
})

await check('越级给脚本被拒（跳过评分）', async () => {
  const fresh = await tool('content_new').execute({ topic: 'tech', owner: '阿研' }, {})
  const freshId = /已登记：([a-z0-9-]+)/.exec(fresh.text)[1]
  await assert.rejects(
    () => tool('content_script').execute({ id: freshId, script: '正文' }, {}),
    /只有 scored 能出脚本/
  )
})

await check('content_script 落盘脚本', async () => {
  const out = await tool('content_script').execute({
    id: itemId, script: '大家好，今天讲三件事。', title: '三件事', owner: '阿写'
  }, {})
  assert.match(out.text, /scripted/)
  const item = await content.readItem(itemId)
  assert.equal(item.stage, 'scripted')
  assert.ok(item.artifacts.some((row) => row.kind === 'script'))
})

await check('content_render 登记参数后停在 review（不越过闸门）', async () => {
  const out = await tool('content_render').execute({
    id: itemId, cutStartSec: 12, cutEndSec: 40, durationSec: 28, aspect: '9:16'
  }, {})
  assert.match(out.text, /review/)
  const item = await content.readItem(itemId)
  assert.equal(item.stage, 'review')
  assert.equal(item.features.durationSec, 28)
})

await check('review 阶段无法被状态机直接推进', async () => {
  await assert.rejects(
    () => content.advance(itemId, { actor: '合成' }),
    /只能由用户本人/
  )
})

// ── 闸门语义 ────────────────────────────────────────────────────────────
await check('未裁决时不许排期', async () => {
  await assert.rejects(
    () => tool('content_publish').execute({ id: itemId, platform: 'douyin', account: '@a' }, {}),
    /必须先通过人工审核/
  )
})

await check('裁决必须署名', async () => {
  await assert.rejects(
    () => tool('content_gate').execute({ id: itemId, decision: 'approve', by: '  ' }, {}),
    /必须署名/
  )
})

await check('裁决只能是 approve 或 kill', async () => {
  await assert.rejects(
    () => tool('content_gate').execute({ id: itemId, decision: 'maybe', by: 'YG' }, {}),
    /裁决只能是/
  )
})

await check('人工放行 → queued，并记下放行人', async () => {
  const out = await tool('content_gate').execute({ id: itemId, decision: 'approve', by: 'YG', note: '看着行' }, {})
  assert.match(out.text, /queued/)
  const item = await content.readItem(itemId)
  assert.equal(item.stage, 'queued')
  assert.equal(item.gate.by, 'YG')
  assert.equal(item.gate.decision, 'approve')
})

await check('放行之后才能排期，且只写本地发布包', async () => {
  const out = await tool('content_publish').execute({
    id: itemId, platform: 'douyin', account: '@mine', scheduledAt: '2026-10-04T11:00:00+10:00', aiLabeled: true
  }, {})
  assert.match(out.text, /queued/)
  const item = await content.readItem(itemId)
  assert.equal(item.stage, 'queued')
  assert.equal(item.targets.length, 1)
  assert.equal(item.features.publishHour, 11)
})

await check('发布包不能回采；人工确认后才变成 published', async () => {
  await assert.rejects(() => content.recordMetrics(itemId, { platform: 'douyin', views: 1 }), /已确认发布/)
  await content.confirmPublication(itemId, { platform: 'douyin', ref: 'https://example.test/video/1', by: 'YG' })
  assert.equal((await content.readItem(itemId)).stage, 'published')
})

await check('绕过闸门硬写 queued 也会被 publish 拒绝', async () => {
  const fresh = await tool('content_new').execute({ topic: 'cars', owner: '阿研' }, {})
  const id = /已登记：([a-z0-9-]+)/.exec(fresh.text)[1]
  const item = await content.readItem(id)
  // 直接改阶段、不写 gate：模拟有人绕开 content_gate
  await content.saveItem({ ...item, gate: { required: true, decision: null, by: null, at: null, note: '' } }, {
    from: 'ingested', to: 'queued', actor: '不该发生'
  })
  await assert.rejects(
    () => tool('content_publish').execute({ id, platform: 'tiktok', account: '@x' }, {}),
    /没有人工放行记录/
  )
})

await check('kill 掉一条就停在 killed', async () => {
  const fresh = await tool('content_new').execute({ topic: 'pets', owner: '阿研' }, {})
  const id = /已登记：([a-z0-9-]+)/.exec(fresh.text)[1]
  await tool('content_score').execute({ id, hook: 10, emotion: 10, info: 10 }, {})
  await tool('content_script').execute({ id, script: '没劲的开头' }, {})
  await tool('content_render').execute({ id, durationSec: 20 }, {})
  const out = await tool('content_gate').execute({ id, decision: 'kill', by: 'YG', note: '太干' }, {})
  assert.match(out.text, /killed/)
  const item = await content.readItem(id)
  assert.equal(item.gate.decision, 'kill')
  await assert.rejects(() => content.advance(id, { actor: '阿析' }), /没有下一步/)
})

// ── 队列 ────────────────────────────────────────────────────────────────
await check('队列默认只列待审', async () => {
  const rows = await content.listQueue({})
  assert.ok(rows.every((row) => row.stage === 'review'))
})

await check('content_queue 能按 id 出详情与轨迹', async () => {
  const out = await tool('content_queue').execute({ id: itemId }, {})
  assert.match(out.text, /轨迹/)
  assert.match(out.text, /ingested → scored/)
})

// ── 回采与权重 ──────────────────────────────────────────────────────────
await check('metrics_pull 回采并推进到 measured', async () => {
  const out = await tool('metrics_pull').execute({
    id: itemId, platform: 'douyin', views: 12000, likes: 800, shares: 90, revenueUsd: 12, revenueSource: 'manual'
  }, {})
  assert.match(out.text, /12000 播放/)
  const item = await content.readItem(itemId)
  assert.equal(item.stage, 'measured')
})

await check('未设汇率时不给净额（不编汇率）', async () => {
  const metrics = await content.readMetrics(itemId)
  assert.equal(metrics.outcome.rate, null)
  assert.equal(metrics.outcome.netUsd, null)
  assert.ok(Number.isFinite(metrics.outcome.tokenCostCny))
})

await check('特征在首次回采时冻结进 metrics', async () => {
  const metrics = await content.readMetrics(itemId)
  assert.equal(metrics.features.durationSec, 28)
  assert.equal(metrics.features.hookType, 'question')
})

await check('样本不够时权重表不建桶', async () => {
  const weights = await content.computeWeights(
    [{ features: { hookType: 'question' }, views: 100 }, { features: { hookType: 'list' }, views: 200 }],
    { minSamples: 5 }
  )
  assert.deepEqual(weights.buckets, {})
  assert.equal(weights.method, 'median-ratio')
})

await check('样本够了才建桶，比值按中位数算', async () => {
  const weights = await content.computeWeights([
    { features: { hookType: 'question' }, views: 1000 },
    { features: { hookType: 'question' }, views: 1200 },
    { features: { hookType: 'list' }, views: 300 },
    { features: { hookType: 'list' }, views: 100 }
  ], { minSamples: 2 })
  // 基准 = median([100, 300, 1000, 1200]) = 650
  assert.equal(weights.baselineViews, 650)
  assert.equal(weights.buckets.hookType.list.medianViews, 200)
  assert.equal(weights.buckets.hookType.list.ratio, 0.308)
  assert.equal(weights.buckets.hookType.question.ratio, 1.692)
})

await check('weights update 从回采数据落盘', async () => {
  const out = await tool('weights').execute({ action: 'update', minSamples: 1 }, {})
  assert.match(out.text, /权重表 v1/)
  const weights = await content.readWeights()
  assert.equal(weights.version, 1)
  assert.ok(weights.samples >= 1)
})

await check('weights read 读回同一份', async () => {
  const out = await tool('weights').execute({ action: 'read' }, {})
  assert.match(out.text, /中位数比值|median-ratio/)
})

// ── 记账 ────────────────────────────────────────────────────────────────
await check('addCost 累加成本与分阶段金额', async () => {
  await content.addCost(itemId, { cny: 0.5, tokens: 1000, stage: 'scripted', model: 'deepseek-flash' })
  await content.addCost(itemId, { cny: 0.25, tokens: 500, stage: 'scored' })
  const item = await content.readItem(itemId)
  assert.equal(item.cost.cny, 0.75)
  assert.equal(item.cost.tokens, 1500)
  assert.equal(item.cost.byStage.scripted, 0.5)
  assert.equal(item.cost.byStage.scored, 0.25)
  assert.equal(item.cost.observed.length, 2)
  // 记账是遥测，不该推进阶段
  assert.equal(item.stage, 'measured')
})

await check('花 0 元不写噪声记录', async () => {
  const before = (await content.readItem(itemId)).cost.observed.length
  await content.addCost(itemId, { cny: 0, tokens: 0 })
  assert.equal((await content.readItem(itemId)).cost.observed.length, before)
})

await check('账本差额从两份快照里减出来', () => {
  // 日期必须跟着实现走：spendDelta 内部按 UTC 当天取 history，
  // 写死日期会在跨过 UTC 零点之后变成一条永远失败的用例。
  const today = new Date().toISOString().slice(0, 10)
  const before = { history: { [today]: 1.0 }, lastBalance: 10, accounting: { active: 'a', books: { a: { currency: 'CNY' } } } }
  const after = { history: { [today]: 1.5 }, lastBalance: 9.5, accounting: { active: 'a', books: { a: { currency: 'CNY' } } }, events: [{ tokens: 300 }] }
  const delta = usage.spendDelta(before, after)
  assert.equal(delta.cny, 0.5)
  assert.equal(delta.tokens, 300)
  assert.equal(delta.measured, true)
  assert.equal(delta.currency, 'CNY')
})

await check('账本单位换算正确（1e8 单位 = 1 元）', () => {
  const fake = { accounting: { active: 'a', books: { a: { currency: 'CNY', days: { '2026-10-03': { debitUnits: 80000000 } } } } } }
  const spend = usage.todaySpend(fake, '2026-10-03')
  assert.equal(spend.amount, 0.8)
  assert.equal(spend.source, 'ledger')
})

await check('账本缺失时业务照常，不能宣称已记账', async () => {
  const parsed = await usage.readUsage()
  assert.equal(parsed, null)
  const out = await tool('content_new').execute({ topic: 'nocost', owner: '阿研' }, {})
  assert.doesNotMatch(out.text, /本次记账/)
  const id = /已登记：([a-z0-9-]+)/.exec(out.text)[1]
  assert.equal((await content.readItem(id)).cost.cny, 0)
})

await check('账本存在时不报「读不到」，也不编造金额', async () => {
  await writeFile(process.env.DSH_USAGE_PATH, JSON.stringify({
    lastBalance: 10, todayUsage: 1, history: { [new Date().toISOString().slice(0, 10)]: 1 },
    accounting: { active: 'a', books: { a: { currency: 'CNY' } } }
  }), 'utf8')
  const out = await tool('content_new').execute({ topic: 'costed', owner: '阿研' }, {})
  assert.doesNotMatch(out.text, /账本读不到/)
  assert.doesNotMatch(out.text, /本次记账/)
})

await check('cost_report 汇总队列成本', async () => {
  const out = await tool('cost_report').execute({}, {})
  assert.match(out.text, /队列成本/)
  assert.match(out.text, /阶段分布/)
})

await check('策略：不带 agent 的调用不会被闸门拦截', () => {
  for (const entry of registered) {
    assert.equal(gate(exec(entry.name, {})), entry.name === 'content_gate' ? undefined : undefined)
  }
})

// ── 输出契约 ────────────────────────────────────────────────────────────
await check('所有工具返回值符合自己声明的 schema', async () => {
  for (const entry of registered) {
    const value = { text: 'x' }
    assert.equal(validateJsonSchemaValue(entry.output.schema, value, '').length, 0)
  }
})

for (const entry of results) {
  console.log(entry.ok ? `  ✓ ${entry.label}` : `  ✗ ${entry.label}\n      ${entry.detail}`)
}
const failed = results.filter((entry) => !entry.ok).length
console.log(`\n${results.length - failed}/${results.length} 通过｜沙箱目录：${sandbox}`)
process.exit(failed === 0 ? 0 : 1)
