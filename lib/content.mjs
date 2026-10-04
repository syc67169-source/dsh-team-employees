// 内容流水线的数据层：状态机 + 审核队列 + 回采 + 权重表。
//
// 与 store.mjs 同样的两条纪律：只用 node 内置模块；绝不 import @deepseek-ai/*。
//
// 这套东西存在的唯一理由：让「选题评分」和「实际播放表现」能对得上账。
// 对不上账，回采数据就是废纸，选题模型永远学不会任何东西。

import { appendFile, mkdir, readdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { teamRoot } from './store.mjs'
import { withFileLock, writeJsonAtomic } from './storage.mjs'

// ── 状态机 ──────────────────────────────────────────────────────────────
// 顺序推进，不可跳级；review 出口必须有人类放行；killed 是任意阶段的终点。
export const STAGES = [
  'ingested', 'scored', 'scripted', 'rendered', 'review',
  'queued', 'published', 'measured', 'archived', 'killed'
]

/** 正常顺序推进的下一个阶段。killed/archived 没有下一个。 */
export const NEXT_STAGE = {
  ingested: 'scored',
  scored: 'scripted',
  scripted: 'rendered',
  rendered: 'review',
  review: 'queued',      // 只有 decideGate() 能走这一步
  queued: 'published',
  published: 'measured',
  measured: 'archived'
}

/** 需要人类放行才能离开的阶段。 */
export const GATED_STAGE = 'review'

/** 合法的人工裁决。 */
export const GATE_DECISIONS = ['approve', 'kill']

// ── 路径 ────────────────────────────────────────────────────────────────
export function contentRoot() {
  return process.env.DSH_TEAM_CONTENT_ROOT || path.join(teamRoot(), 'content')
}

export function metricsRoot() {
  return process.env.DSH_TEAM_METRICS_ROOT || path.join(teamRoot(), 'metrics')
}

export function indexPath() {
  return path.join(contentRoot(), 'index.jsonl')
}

export function itemDir(id) {
  return path.join(contentRoot(), assertItemId(id))
}

export function itemPath(id) {
  return path.join(itemDir(id), 'item.json')
}

export function eventsPath(id) {
  return path.join(itemDir(id), 'events.jsonl')
}

export function scriptPath(id) {
  return path.join(itemDir(id), 'script.md')
}

export function renderPath(id) {
  return path.join(itemDir(id), 'render.json')
}

export function publishPath(id) {
  return path.join(itemDir(id), 'publish.json')
}

export function metricsPath(id) {
  return path.join(metricsRoot(), `${assertItemId(id)}.json`)
}

export function weightsPath() {
  return path.join(metricsRoot(), 'weights.json')
}

// ── id 与安全 ───────────────────────────────────────────────────────────
const ITEM_ID = /^[a-z0-9][a-z0-9-]{2,63}$/

/**
 * 校验 item id。id 会拼进文件路径，所以这里是防目录穿越的唯一关口：
 * 上游是模型生成的字符串，不是可信输入。
 */
export function assertItemId(id) {
  const value = String(id ?? '')
  if (!ITEM_ID.test(value)) {
    throw new Error(`非法 item id「${value}」：只允许小写字母/数字/连字符，长度 3-64，且不能以连字符开头`)
  }
  return value
}

export function slugify(topic) {
  const slug = String(topic ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.slice(0, 24) || 'item'
}

export function idPrefix(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at)
  const stamp = [d.getFullYear(), d.getMonth() + 1, d.getDate()]
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0')))
    .join('')
  return stamp
}

/** 当天同主题的下一个序号，从已有索引里数出来，不靠随机数。 */
export function nextSequence(existing, prefix, slug) {
  const head = `${prefix}-${slug}-`
  let max = 0
  for (const entry of existing) {
    const id = String(entry?.id ?? '')
    if (!id.startsWith(head)) continue
    const tail = Number.parseInt(id.slice(head.length), 10)
    if (Number.isSafeInteger(tail) && tail > max) max = tail
  }
  return max + 1
}

// ── 底层读写 ────────────────────────────────────────────────────────────
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function readTextSafe(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** 读 jsonl，坏行跳过——半行写入不该让整份数据不可读。 */
export async function readJsonl(file) {
  const raw = await readTextSafe(file)
  if (raw === null) return []
  const rows = []
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // 跳过坏行
    }
  }
  return rows
}

// ── 队列索引 ────────────────────────────────────────────────────────────
/** index.jsonl 只存摘要，让面板不必遍历所有人的目录。 */
export function indexRow(item) {
  return {
    id: item.id,
    stage: item.stage,
    topic: item.features?.topic ?? '',
    total: item.score?.total ?? null,
    owner: item.owner ?? '',
    gateBy: item.gate?.by ?? null,
    updatedAt: item.updatedAt
  }
}

export async function readIndex() {
  return readJsonl(indexPath())
}

export async function appendIndex(item) {
  return withFileLock(indexPath(), async () => {
    const latest = new Map((await readIndex()).map(row => [row.id, row]))
    latest.set(item.id, indexRow(item))
    const temp = `${indexPath()}.tmp-${process.pid}-${randomUUID()}`
    try {
      await writeFile(temp, [...latest.values()].map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' })
      await rename(temp, indexPath())
    } finally {
      await rm(temp, { force: true })
    }
  })
}

// ── 建条目 ──────────────────────────────────────────────────────────────
/**
 * 登记一条素材，落在 ingested 阶段。
 * 素材的授权（license）在这里写死：切片别人的内容，授权凭证必须随素材一起进库，
 * 否则后面无法回答「这条凭什么能发」。
 */
export async function createItem(options = {}) {
  return withFileLock(indexPath(), () => createItemUnlocked(options))
}

async function createItemUnlocked({ topic, source, owner, features = {}, now = new Date(), id = null } = {}) {
  const index = await readIndex()
  const resolved = id ?? `${idPrefix(now)}-${slugify(topic)}-${String(nextSequence(index, idPrefix(now), slugify(topic))).padStart(3, '0')}`
  assertItemId(resolved)
  if (await readItemOrNull(resolved)) throw new Error(`条目 ${resolved} 已存在，拒绝覆盖`)
  const item = {
    id: resolved,
    stage: 'ingested',
    revision: 1,
    owner: typeof owner === 'string' ? owner : '',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    source: {
      kind: source?.kind ?? 'own',
      ref: String(source?.ref ?? ''),
      license: String(source?.license ?? 'own'),
      capturedAt: source?.capturedAt ?? now.toISOString()
    },
    score: null,
    features: {
      topic: slugify(topic),
      hookType: features.hookType ?? 'unknown',
      durationSec: Number.isFinite(features.durationSec) ? features.durationSec : 0,
      hasFace: features.hasFace === true,
      captionStyle: features.captionStyle ?? 'unknown',
      publishHour: null
    },
    artifacts: [],
    targets: [],
    gate: { required: true, decision: null, by: null, at: null, note: '' },
    cost: { cny: 0, currency: 'CNY', tokens: 0, byStage: {}, observed: [] }
  }
  await writeJsonAtomic(itemPath(resolved), item)
  await mkdir(itemDir(resolved), { recursive: true })
  await writeEvents(resolved, { from: null, to: 'ingested', actor: item.owner || '系统', reason: '登记素材' })
  await appendIndex(item)
  return item
}

// ── 事件流 ──────────────────────────────────────────────────────────────
async function writeEvents(id, event) {
  await mkdir(itemDir(id), { recursive: true })
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`
  await appendFile(eventsPath(id), line, 'utf8')
  return line.trim()
}

export async function readEvents(id) {
  return readJsonl(eventsPath(id))
}

// ── 读条目 ──────────────────────────────────────────────────────────────
export async function readItem(id) {
  const wanted = assertItemId(id)
  const item = await readJson(itemPath(wanted))
  if (item === null) throw new Error(`没有 id 为「${wanted}」的内容条目`)
  return item
}

export async function readItemOrNull(id) {
  try {
    return await readJson(itemPath(id))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/**
 * 保存条目并记一条事件。expect 用于乐观并发：状态被别的员工改过就拒绝写入，
 * 而不是让两个人互相覆盖结论。
 */
export async function saveItem(item, options = {}) {
  return withFileLock(itemPath(item.id), () => saveItemUnlocked(item, options))
}

async function saveItemUnlocked(item, { from, to, actor, reason = '', evidence = [], expect = null } = {}) {
  const current = await readItem(item.id)
  if (current.revision !== item.revision) throw new Error(`条目 ${item.id} 版本冲突，请重新读取后重试`)
  if (expect !== null && current.stage !== expect) {
    throw new Error(`条目 ${item.id} 当前在 ${item.stage} 阶段，不是 ${expect}；可能被其他员工推进过，请重新读取`)
  }
  const next = {
    ...item,
    stage: to ?? item.stage,
    revision: (Number.isSafeInteger(item.revision) ? item.revision : 1) + 1,
    updatedAt: new Date().toISOString()
  }
  await writeJsonAtomic(itemPath(next.id), next)
  await writeEvents(next.id, { from: from ?? item.stage, to: next.stage, actor, reason, evidence })
  await appendIndex(next)
  return next
}

/** 按状态机推进一步。不允许跳级，也不允许绕过 review 出口。 */
export async function advance(id, options = {}) {
  return withFileLock(itemPath(id), () => advanceUnlocked(id, options))
}

async function advanceUnlocked(id, { actor, reason = '', evidence = [], expect = null } = {}) {
  const item = await readItem(id)
  if (expect !== null && item.stage !== expect) {
    throw new Error(`条目 ${id} 当前在 ${item.stage} 阶段，不是 ${expect}`)
  }
  if (item.stage === 'queued') throw new Error('发布需要人工确认平台链接，不能自动推进')
  if (item.stage === GATED_STAGE) {
    throw new Error(`条目 ${id} 停在「${GATED_STAGE}」：这一步只能由用户本人在面板或会话里放行，员工不得越过`)
  }
  const target = NEXT_STAGE[item.stage]
  if (target === undefined) throw new Error(`条目 ${id} 在 ${item.stage} 阶段：没有下一步可走`)
  return saveItem(item, { from: item.stage, to: target, actor, reason, evidence, expect: null })
}

// ── 成本记账 ────────────────────────────────────────────────────────────
/**
 * 往条目上记一笔真实支出。成本是遥测，不是状态转移：不推进阶段、不记事件、
 * 更新 revision 以免旧快照覆盖新成本；不追加阶段事件。
 */
export async function addCost(id, options = {}) {
  return withFileLock(itemPath(id), () => addCostUnlocked(id, options))
}

async function addCostUnlocked(id, { cny = 0, tokens = 0, stage = null, model = '', at = new Date() } = {}) {
  const item = await readItem(id)
  const amount = Number.isFinite(cny) ? cny : 0
  const tokenCount = Number.isFinite(tokens) ? tokens : 0
  if (amount === 0 && tokenCount === 0) return item
  const cost = {
    ...item.cost,
    cny: Number(((Number(item.cost?.cny) || 0) + amount).toFixed(6)),
    tokens: (Number(item.cost?.tokens) || 0) + tokenCount,
    byStage: { ...(item.cost?.byStage ?? {}) }
  }
  if (stage !== null) {
    cost.byStage[stage] = Number(((Number(cost.byStage[stage]) || 0) + amount).toFixed(6))
  }
  const observed = Array.isArray(item.cost?.observed) ? item.cost.observed.slice(-49) : []
  observed.push({ at: at.toISOString(), cny: amount, tokens: tokenCount, model, stage })
  const next = { ...item, revision: item.revision + 1, cost: { ...cost, observed }, updatedAt: at.toISOString() }
  await writeJsonAtomic(itemPath(next.id), next)
  return next
}

// ── 人工闸门 ────────────────────────────────────────────────────────────
/**
 * 人类裁决。这是整条流水线上唯一不可自动化的动作，也是它在代码里的落点：
 * by 必须是人，decision 只允许 approve/kill。approve 之后才可能出现 queued。
 */
export async function decideGate(id, options = {}) {
  return withFileLock(itemPath(id), () => decideGateUnlocked(id, options))
}

async function decideGateUnlocked(id, { by, decision, note = '', at = new Date() } = {}) {
  const operator = String(by ?? '').trim()
  if (operator.length === 0) throw new Error('人工裁决必须署名（by）：这条记录会被人回头看')
  if (!GATE_DECISIONS.includes(decision)) {
    throw new Error(`裁决只能是 ${GATE_DECISIONS.join(' 或 ')}，收到「${decision}」`)
  }
  const item = await readItem(id)
  if (item.stage !== GATED_STAGE) {
    throw new Error(`条目 ${id} 在 ${item.stage} 阶段，不在待审队列里`)
  }
  const gate = {
    required: true,
    decision,
    by: operator,
    at: at.toISOString(),
    note: String(note ?? '')
  }
  const target = decision === 'approve' ? 'queued' : 'killed'
  return saveItem({ ...item, gate }, {
    from: item.stage, to: target, actor: operator, reason: `人工裁决：${decision}`
  })
}

/** 按阶段列队列，默认只列待审的。 */
export async function listQueue({ stage = GATED_STAGE, limit = 20 } = {}) {
  const rows = await readIndex()
  const wanted = typeof stage === 'string' && stage.length > 0 ? stage : null
  // 同一 id 会随状态推进反复入索引，取每个 id 的最后一条
  const latest = new Map()
  for (const row of rows) latest.set(row.id, row)
  const size = Number.isSafeInteger(limit) && limit > 0 ? limit : 20
  return [...latest.values()]
    .filter(row => wanted === null || row.stage === wanted)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, limit === null ? undefined : size)
}

// ── 回采 ────────────────────────────────────────────────────────────────
export async function readMetrics(id) {
  return readJson(metricsPath(id))
}

export async function readAllMetrics() {
  let names
  try {
    names = await readdir(metricsRoot())
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const out = []
  for (const file of names) {
    if (!file.endsWith('.json') || file === 'weights.json') continue
    const parsed = await readJson(path.join(metricsRoot(), file))
    if (parsed !== null) out.push(parsed)
  }
  return out
}

/**
 * 写入或合并一条平台回采。
 * features 在第一次回采时从 item 冻结进来——发布之后特征就不能再改，
 * 否则权重表会把「发布后编辑过的特征」和「当时的播放量」对到一起，归因全废。
 */
export async function recordMetrics(id, options = {}) {
  return withFileLock(itemPath(id), () => recordMetricsUnlocked(id, options))
}

async function recordMetricsUnlocked(id, { platform, views, likes = 0, comments = 0, shares = 0, saves = 0, revenueUsd = 0, revenueSource = 'manual', item = null, at = new Date() } = {}) {
  const name = String(platform ?? '').trim().toLowerCase()
  if (name.length === 0) throw new Error('回采必须指明 platform')
  item = await readItem(id)
  if (!['published', 'measured'].includes(item.stage)) throw new Error('只有已确认发布的内容才能回采')
  if (!(item.targets ?? []).some(row => row.platform === name && row.confirmedAt)) throw new Error('该平台尚未确认发布，不能回采')
  for (const [label, value] of Object.entries({ views, likes, comments, shares, saves })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负整数`)
  }
  if (!Number.isFinite(revenueUsd) || revenueUsd < 0) throw new Error('收入必须是非负数字')
  if (!Number.isFinite(views) || views < 0) throw new Error('回采必须给非负整数 views')

  const existing = (await readMetrics(id)) ?? {
    itemId: assertItemId(id),
    pulledAt: at.toISOString(),
    features: item.targets.find(row => row.platform === name)?.features ?? item.features,
    scoreAtGate: item?.score?.total ?? null,
    platforms: {}
  }
  const merged = {
    ...existing,
    pulledAt: at.toISOString(),
    platforms: {
      ...existing.platforms,
      [name]: {
        views, likes, comments, shares, saves,
        revenueUsd: Number.isFinite(revenueUsd) ? revenueUsd : 0,
        revenueSource,
        capturedAt: at.toISOString()
      }
    }
  }
  const totalRevenue = Object.values(merged.platforms).reduce((sum, row) => sum + (Number(row?.revenueUsd) || 0), 0)
  const totalViews = Object.values(merged.platforms).reduce((sum, row) => sum + (Number(row?.views) || 0), 0)
  const rate = Number(process.env.DSH_USD_CNY)
  const costCny = Number(item?.cost?.cny) || 0
  merged.outcome = {
    viewsTotal: totalViews,
    revenueUsd: Number(totalRevenue.toFixed(4)),
    tokenCostCny: Number(costCny.toFixed(4)),
    // 不硬编码汇率：两个原值永远都留着，只有显式设定 DSH_USD_CNY 时才额外给出净额
    rate: Number.isFinite(rate) && rate > 0 ? rate : null,
    netUsd: Number.isFinite(rate) && rate > 0
      ? Number((totalRevenue - costCny / rate).toFixed(4))
      : null
  }
  await writeJsonAtomic(metricsPath(id), merged)
  return merged
}

// ── 权重表：可解释，不训练 ──────────────────────────────────────────────
export const WEIGHT_DIMENSIONS = ['hookType', 'topic', 'publishHour', 'durationBucket', 'hasFace']

export function durationBucket(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return 'unknown'
  if (value < 20) return '<20'
  if (value < 30) return '20-30'
  if (value < 45) return '30-45'
  if (value < 60) return '45-60'
  return '>=60'
}

export function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function bucketKey(dimension, features) {
  if (dimension === 'durationBucket') return durationBucket(features?.durationSec)
  const value = features?.[dimension]
  return value === null || value === undefined || value === '' ? 'unknown' : String(value)
}

/**
 * 用中位数比值建表：ratio = 该桶播放量中位数 / 全样本中位数。
 * 样本数不够的桶不写进去——宁可用不上，也不要让 2 条数据决定明天的选题。
 */
export function computeWeights(samples, { minSamples = 5, version = 1, at = new Date() } = {}) {
  const usable = samples.filter((row) => Number.isFinite(row?.views) && row.views >= 0 && row?.features)
  const baseline = median(usable.map((row) => row.views))
  const buckets = {}
  for (const dimension of WEIGHT_DIMENSIONS) {
    const groups = new Map()
    for (const row of usable) {
      const key = bucketKey(dimension, row.features)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(row.views)
    }
    const table = {}
    for (const [key, values] of groups) {
      if (values.length < minSamples) continue
      const middle = median(values)
      table[key] = {
        n: values.length,
        medianViews: Math.round(middle),
        ratio: baseline > 0 ? Number((middle / baseline).toFixed(3)) : 1
      }
    }
    if (Object.keys(table).length > 0) buckets[dimension] = table
  }
  return {
    version,
    updatedAt: at.toISOString(),
    method: 'median-ratio',
    minSamples,
    samples: usable.length,
    baselineViews: Math.round(baseline),
    buckets
  }
}

export async function readWeights() {
  return readJson(weightsPath())
}

export async function writeWeights(weights) {
  await withFileLock(weightsPath(), () => writeJsonAtomic(weightsPath(), weights))
  return weights
}

/** 从现有回采数据重算并落盘，版本号自增。 */
export async function refreshWeights(options = {}) {
  return withFileLock(weightsPath(), () => refreshWeightsUnlocked(options))
}

async function refreshWeightsUnlocked({ minSamples = 5 } = {}) {
  const previous = await readWeights()
  const metrics = await readAllMetrics()
  const samples = metrics
    .filter((row) => row?.features && Number.isFinite(row?.outcome?.viewsTotal))
    .map((row) => ({ features: row.features, views: row.outcome.viewsTotal }))
  const version = (Number.isSafeInteger(previous?.version) ? previous.version : 0) + 1
  const weights = computeWeights(samples, { minSamples, version })
  return writeWeights(weights)
}

/**
 * 把历史表现折成一个先验乘数，供选题评分参考。
 * 各维度比值取几何平均——不用相乘，避免三个 1.5 倍的桶叠成 3.4 倍的神话。
 */
export function applyWeights(baseScore, features, weights) {
  const ratios = []
  const used = []
  for (const dimension of WEIGHT_DIMENSIONS) {
    const table = weights?.buckets?.[dimension]
    if (table === undefined) continue
    const key = bucketKey(dimension, features)
    const bucket = table[key]
    if (bucket === undefined || !Number.isFinite(bucket.ratio) || bucket.ratio <= 0) continue
    ratios.push(bucket.ratio)
    used.push(`${dimension}=${key}×${bucket.ratio}`)
  }
  if (ratios.length === 0) return { score: baseScore, multiplier: 1, used }
  const multiplier = Math.exp(ratios.reduce((sum, ratio) => sum + Math.log(ratio), 0) / ratios.length)
  return {
    score: Math.max(0, Math.round(baseScore * multiplier)),
    multiplier: Number(multiplier.toFixed(3)),
    used
  }
}

// ── 渲染与格式化 ────────────────────────────────────────────────────────
export function formatQueue(rows) {
  if (rows.length === 0) return '队列是空的。'
  return rows.map((row) => {
    const score = row.total === null || row.total === undefined ? '未评分' : `${row.total} 分`
    const gate = row.gateBy === null || row.gateBy === undefined ? '' : `｜已放行：${row.gateBy}`
    return `- ${row.id}｜${row.stage}｜${score}｜${row.topic || '未分类'}${gate}`
  }).join('\n')
}

export function formatItem(item, events = []) {
  const lines = [
    `id：${item.id}`,
    `阶段：${item.stage}（revision ${item.revision}）`,
    `负责人：${item.owner || '未指派'}`,
    `素材：${item.source.kind}｜授权：${item.source.license}｜来源：${item.source.ref || '未记录'}`,
    item.score === null
      ? '评分：未评分'
      : `评分：${item.score.total}（钩子 ${item.score.hook}／情绪 ${item.score.emotion}／信息 ${item.score.info}，w${item.score.weightsVersion ?? '—'}${item.score.adjusted === undefined ? '' : `，历史修正后 ${item.score.adjusted}`}）`,
    `特征：${JSON.stringify(item.features)}`,
    `已关联成本（非完整实际支出）：${item.cost?.tokens ?? 0} tokens ／ ${item.cost?.cny ?? 0} ${item.cost?.currency ?? 'CNY'}`,
    item.gate.by === null
      ? `人工闸门：${item.gate.required ? '未裁决' : '不需要'}`
      : `人工闸门：${item.gate.decision}（${item.gate.by}）`
  ]
  if (item.artifacts.length > 0) lines.push(`产物：${item.artifacts.map((a) => `${a.kind}:${a.path}`).join('、')}`)
  if (events.length > 0) {
    lines.push('轨迹：')
    for (const event of events.slice(-8)) {
      lines.push(`  ${String(event.at ?? '').replace('T', ' ').slice(0, 16)} ${event.from ?? '—'} → ${event.to}｜${event.actor ?? '?'}｜${event.reason ?? ''}`)
    }
  }
  return lines.join('\n')
}

export function formatWeights(weights) {
  if (weights === null || weights === undefined) {
    return `还没有权重表。至少 ${5} 条带播放数据的条目才能建表。文件：${weightsPath()}`
  }
  const lines = [
    `权重表 v${weights.version}｜样本 ${weights.samples} 条｜基准中位播放 ${weights.baselineViews}｜方法 ${weights.method}｜门槛 ${weights.minSamples}`,
    `更新于 ${weights.updatedAt}`
  ]
  for (const [dimension, table] of Object.entries(weights.buckets ?? {})) {
    const cells = Object.entries(table).map(([key, cell]) => `${key} ×${cell.ratio}(n=${cell.n})`)
    lines.push(`- ${dimension}：${cells.join('，')}`)
  }
  if (Object.keys(weights.buckets ?? {}).length === 0) {
    lines.push('（样本还不够，没有任何桶达到门槛。这是正常的，不要据此下结论。）')
  }
  return lines.join('\n')
}

/** 面板用：token 花在哪、换回多少。 */
export function summarizeCost(items) {
  const byStage = {}
  let tokens = 0
  let cny = 0
  for (const item of items) {
    tokens += Number(item?.cost?.tokens) || 0
    cny += Number(item?.cost?.cny) || 0
    const stage = item?.stage ?? 'unknown'
    byStage[stage] = (byStage[stage] ?? 0) + 1
  }
  return { count: items.length, tokens, cny: Number(cny.toFixed(4)), byStage }
}

/** Human confirms a real publication; preparing a package never publishes it. */
export async function confirmPublication(id, { platform, ref, by, at = new Date() } = {}) {
  return withFileLock(itemPath(id), async () => {
    const item = await readItem(id)
    if (!['queued', 'published', 'measured'].includes(item.stage) || item.gate?.decision !== 'approve') throw new Error('条目必须已通过人工审核')
    const target = item.targets?.find(row => row.platform === platform)
    if (!target) throw new Error('请先准备该平台的发布包')
    const operator = String(by ?? '').trim()
    const reference = String(ref ?? '').trim()
    if (!operator || !reference) throw new Error('发布确认必须填写署名和平台发布链接/记录编号')
    if (target.confirmedAt) throw new Error('该平台已经确认发布，请勿重复确认')
    const targets = item.targets.map(row => row === target ? { ...row, confirmedAt: at.toISOString(), ref: reference, by: operator, features: { ...item.features } } : row)
    return saveItem({ ...item, targets }, { to: item.stage === 'measured' ? 'measured' : 'published', actor: operator, reason: `确认发布 ${platform}`, evidence: [reference] })
  })
}
