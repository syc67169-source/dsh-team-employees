// Agent 平面：内容流水线的员工工具，加一道不可绕过的闸门。
//
// 三条设计纪律，改代码前先读：
//   1) 能用确定性代码做的，不交给模型。合成、转码、排期都是写文件，不是推理。
//   2) 谁能做什么由「阶段契约」决定，不由员工名字决定。名字是人改着玩的，
//      阶段是数据的一部分。
//   3) guard 只做同步判断（宿主就是这么设计的：guard 返回字符串即否决，
//      不 await）。需要读盘的规则一律放在 execute() 里，别指望 guard 帮你查文件。

import {
  GATE_DECISIONS, STAGES, addCost, advance, applyWeights, assertItemId, createItem, decideGate,
  eventsPath, formatItem, formatQueue, formatWeights, itemPath, listQueue,
  publishPath, readEvents, readItem, readItemOrNull, readWeights, recordMetrics,
  refreshWeights, renderPath, saveItem, scriptPath, summarizeCost
} from './content.mjs'
import { writeFile } from 'node:fs/promises'
import { formatUsage, readUsage, spendDelta } from './usage.mjs'

export const name = 'team-employees/content'
export const inject = ['tools']

const PLATFORMS = ['douyin', 'tiktok', 'youtube_shorts', 'xhs', 'bilibili']
const SOURCE_KINDS = ['own', 'campaign', 'rss', 'licensed']
const HOOK_TYPES = ['question', 'shock', 'list', 'story', 'contrast', 'unknown']

const textOutput = (args, value) => [{ type: 'text', text: String(value?.text ?? '') }]
const output = () => ({
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text']
  },
  render: textOutput
})

/** 把 0-100 的整数夹住，模型经常给 105 或者 -3。 */
function score(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new Error(`${label} 必须是 0-100 的数字，收到「${value}」`)
  }
  return Math.round(number)
}

/**
 * 从排期字符串里取「写出来的那个小时」，不做时区换算。
 * 这不是偷懒：排期时间是给人看的，换算只会把 19:00 悄悄变成 20:00，
 * 而回头看数据时没人知道为什么。要改时区请在字符串里写清楚。
 */
function hourAsWritten(value) {
  const match = /T(\d{2})/.exec(String(value ?? ''))
  if (match !== null) {
    const hour = Number(match[1])
    if (hour >= 0 && hour <= 23) return hour
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getHours()) ? null : parsed.getHours()
}

function requireText(value, label) {
  const text = String(value ?? '').trim()
  if (text.length === 0) throw new Error(`${label} 不能为空`)
  return text
}

/**
 * 统一包装：跑之前读一次本地账本，跑完再读一次，差额记到这条内容上。
 * 这样「这条视频花了多少钱」是账本减出来的，不是估的。
 */
function defineTool({ name: toolName, description, parameters, run }) {
  return {
    name: toolName,
    description,
    parameters,
    output: output(),
    async execute(args) {
      const before = await readUsage()
      const result = await run(args ?? {})
      const after = await readUsage()
      const delta = spendDelta(before, after)
      let suffix = ''
      if (result?.costFor !== undefined) {
        if (delta.measured) {
          await addCost(result.costFor, {
            cny: delta.cny,
            tokens: delta.tokens,
            stage: result.costStage ?? null,
            model: after?.events?.slice(-1)?.[0]?.model ?? ''
          })
          suffix = `\n本次记账：${delta.cny} CNY ／ ${delta.tokens} tokens（本地账本差额）`
        } else {
          suffix = '\n（本地账本读不到，本次未记账；流水线不受影响。）'
        }
      }
      return { text: `${result?.text ?? ''}${suffix}` }
    }
  }
}

export function apply(ctx) {
  // ── 唯一的硬闸门：裁决权只属于人 ──────────────────────────────────────
  // exec.agent 有值 = 这次调用来自某个员工会话。闸门这一步必须是人工动作，
  // 所以员工无论被怎么提示，都推不动 review → queued 这一步。
  ctx.tools.guard((exec) => {
    if (exec?.name !== 'content_gate') return undefined
    if (exec?.agent !== undefined) {
      return 'content_gate 是人工闸门：只有用户本人能裁决。请把条目留在 review 阶段，并明确告诉用户「有 N 条等你过一眼」。'
    }
    return undefined
  })

  // ── 1. 素材入站（阿研） ────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'content_new',
    description:
      '登记一条待加工素材，落到 ingested 阶段。授权（license）必须如实填：切片别人的内容时，这就是「凭什么能发」的唯一凭证，事后补不回来。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topic: { type: 'string', description: '主题词，会进 id 和特征向量，用英文小写更好' },
        ref: { type: 'string', description: '素材出处：链接或文件名' },
        kind: { type: 'string', enum: SOURCE_KINDS, description: '素材性质：自有 / 官方 campaign / RSS / 已获授权' },
        license: { type: 'string', description: '授权凭证：campaign id、合同号，或 own' },
        owner: { type: 'string', description: '登记人：你自己的名字或 id' }
      },
      required: ['topic']
    },
    async run(args) {
      const item = await createItem({
        topic: requireText(args.topic, 'topic'),
        source: {
          kind: SOURCE_KINDS.includes(args.kind) ? args.kind : 'own',
          ref: String(args.ref ?? ''),
          license: String(args.license ?? 'own')
        },
        owner: typeof args.owner === 'string' ? args.owner : ''
      })
      return {
        text: `已登记：${item.id}\n位置：${itemPath(item.id)}\n阶段：ingested → 下一步该 ${'阿筛'} 打分（content_score）。`,
        costFor: item.id,
        costStage: 'ingested'
      }
    }
  }))

  // ── 2. 选题评分（阿筛） ────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'content_score',
    description:
      '给一条 ingested 素材打分，推进到 scored。分数在发布时被冻结，之后谁也改不了——这是回采数据能不能用来学习的唯一前提。开工前先看 weights（action=read）拿历史先验。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '条目 id' },
        hook: { type: 'integer', description: '前三秒钩子强度 0-100' },
        emotion: { type: 'integer', description: '情绪张力 0-100' },
        info: { type: 'integer', description: '信息密度 0-100' },
        hookType: { type: 'string', enum: HOOK_TYPES, description: '钩子类型，进特征向量' },
        note: { type: 'string', description: '一句话说明为什么打这个分' }
      },
      required: ['id', 'hook', 'emotion', 'info']
    },
    async run(args) {
      const id = assertItemId(args.id)
      const item = await readItem(id)
      if (item.stage !== 'ingested') {
        throw new Error(`条目 ${id} 在 ${item.stage} 阶段，只有 ingested 能打分（一条内容只评一次分）`)
      }
      const hook = score(args.hook, 'hook')
      const emotion = score(args.emotion, 'emotion')
      const info = score(args.info, 'info')
      const total = Math.round((hook + emotion + info) / 3)
      const features = {
        ...item.features,
        hookType: HOOK_TYPES.includes(args.hookType) ? args.hookType : 'unknown'
      }
      const weights = await readWeights()
      const hint = applyWeights(total, features, weights)
      const scored = {
        ...item,
        features,
        score: {
          hook, emotion, info, total,
          by: 'select',
          at: new Date().toISOString(),
          weightsVersion: weights?.version ?? null,
          adjusted: hint.score,
          multiplier: hint.multiplier,
          note: String(args.note ?? '')
        }
      }
      const saved = await saveItem(scored, {
        from: item.stage, to: 'scored', actor: '阿筛', reason: `评分 ${total}`
      })
      const lines = [
        `已评分：${saved.id}｜${total} 分（钩子 ${hook}／情绪 ${emotion}／信息 ${info}）`,
        hint.used.length === 0
          ? '历史权重：还没有可用样本，本次未修正。这是正常的。'
          : `历史权重修正后：${hint.score} 分（乘数 ${hint.multiplier}，用了 ${hint.used.join('、')}）`,
        '下一步：阿写接手（content_script）。'
      ]
      return { text: lines.join('\n'), costFor: id, costStage: 'scored' }
    }
  }))

  // ── 3. 成稿（阿写） ────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'content_script',
    description:
      '写口播脚本与标题，推进到 scripted。脚本是人要审的东西，写人话，别写「让我们一起探索」这种。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '条目 id' },
        script: { type: 'string', description: '脚本正文（markdown）' },
        title: { type: 'string', description: '标题' },
        owner: { type: 'string', description: '撰写人名字或 id' }
      },
      required: ['id', 'script']
    },
    async run(args) {
      const id = assertItemId(args.id)
      const item = await readItem(id)
      if (item.stage !== 'scored') {
        throw new Error(`条目 ${id} 在 ${item.stage} 阶段，只有 scored 能出脚本（评分是前置条件，不许跳过）`)
      }
      const body = requireText(args.script, 'script')
      const file = scriptPath(id)
      await writeFile(file, `${args.title ? `# ${args.title}\n\n` : ''}${body}\n`, 'utf8')
      const saved = await saveItem({
        ...item,
        owner: typeof args.owner === 'string' && args.owner.length > 0 ? args.owner : item.owner,
        artifacts: upsertArtifact(item.artifacts, { kind: 'script', path: file, bytes: Buffer.byteLength(body, 'utf8') })
      }, { from: item.stage, to: 'scripted', actor: '阿写', reason: '出脚本', evidence: [file] })
      return {
        text: `脚本已写入：${file}\n${saved.id} → scripted\n下一步：合成（content_render，确定性步骤，不需要员工）。`,
        costFor: id, costStage: 'scripted'
      }
    }
  }))

  // ── 4. 合成（确定性，不设员工） ────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'content_render',
    description:
      '登记切片与渲染参数（起止秒、画幅、字幕、成片路径），推进到 review 待审。这一步只写参数，不调 ffmpeg——真正的转码交给 bin/render.mjs，因为它不需要任何判断。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '条目 id' },
        cutStartSec: { type: 'number', description: '切片起点（秒）' },
        cutEndSec: { type: 'number', description: '切片终点（秒）' },
        durationSec: { type: 'number', description: '成片时长（秒），进特征向量' },
        aspect: { type: 'string', enum: ['9:16', '1:1', '16:9'], description: '画幅' },
        outline: { type: 'string', description: '成片路径，例如 out/<id>.mp4' },
        captions: { type: 'string', description: '字幕文件名，例如 <id>.srt' }
      },
      required: ['id']
    },
    async run(args) {
      const id = assertItemId(args.id)
      const item = await readItem(id)
      if (item.stage !== 'scripted') {
        throw new Error(`条目 ${id} 在 ${item.stage} 阶段，只有 scripted 能进合成`)
      }
      const duration = Number.isFinite(Number(args.durationSec)) ? Number(args.durationSec) : 0
      const plan = {
        id,
        cutStartSec: Number(args.cutStartSec ?? 0),
        cutEndSec: Number(args.cutEndSec ?? 0),
        durationSec: duration,
        aspect: ['9:16', '1:1', '16:9'].includes(args.aspect) ? args.aspect : '9:16',
        output: String(args.outline ?? `out/${id}.mp4`),
        captions: String(args.captions ?? `${id}.srt`),
        plannedAt: new Date().toISOString()
      }
      const file = renderPath(id)
      await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
      const withPlan = {
        ...item,
        features: { ...item.features, durationSec: duration },
        artifacts: upsertArtifact(item.artifacts, { kind: 'render-plan', path: file })
      }
      await saveItem(withPlan, { from: item.stage, to: 'rendered', actor: '合成', reason: '登记渲染参数', evidence: [file] })
      const review = await advance(id, { actor: '合成', reason: '成片待审', evidence: [plan.output] })
      return {
        text: `渲染参数已登记：${file}\n${id} → ${review.stage}（等你过一眼）\n这一步没有员工参与：切片和转码不需要判断力，交给代码更便宜也更快。`,
        costFor: id, costStage: 'rendered'
      }
    }
  }))

  // ── 5. 队列与详情 ──────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'content_queue',
    description:
      '看内容队列：默认只看待审（review）。带 id 看单条详情和它的完整轨迹。开工前先看这个，别重复劳动。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '条目 id；给了就看单条详情' },
        stage: { type: 'string', enum: STAGES, description: '按阶段筛，默认 review' },
        limit: { type: 'integer', description: '最多看几条，默认 20' }
      }
    },
    async run(args) {
      if (typeof args.id === 'string' && args.id.trim().length > 0) {
        const id = assertItemId(args.id)
        const item = await readItem(id)
        const events = await readEvents(id)
        return { text: `${formatItem(item, events)}\n\n事件流：${eventsPath(id)}` }
      }
      const rows = await listQueue({
        stage: STAGES.includes(args.stage) ? args.stage : 'review',
        limit: Number.isSafeInteger(args.limit) ? args.limit : 20
      })
      const summary = summarizeCost(
        (await Promise.all(rows.map((row) => readItemOrNull(row.id)))).filter(Boolean)
      )
      return {
        text: `${formatQueue(rows)}\n\n共 ${summary.count} 条｜累计 ${summary.tokens} tokens ／ ${summary.cny} CNY`
      }
    }
  }))

  // ── 6. 人工闸门（只有人能调） ──────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'content_gate',
    description:
      '人工裁决：approve 放行进队列，kill 直接毙掉。这个工具只有用户本人能调用，员工调用会被运行时拒绝——别试，也别替用户决定。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '条目 id' },
        decision: { type: 'string', enum: GATE_DECISIONS, description: 'approve 放行 / kill 毙掉' },
        by: { type: 'string', description: '裁决人署名，默认取 DSH_TEAM_OPERATOR' },
        note: { type: 'string', description: '一句话备注：为什么放行或毙掉' }
      },
      required: ['id', 'decision']
    },
    async run(args) {
      const id = assertItemId(args.id)
      const by = String(args.by ?? process.env.DSH_TEAM_OPERATOR ?? '用户本人').trim()
      const saved = await decideGate(id, {
        by,
        decision: args.decision,
        note: String(args.note ?? '')
      })
      const tail = saved.stage === 'queued'
        ? '已放行 → queued。下一步：content_publish 登记排期（仍要你自己点）。'
        : '已毙掉 → killed。这条不会再有下文，但会留在队列里当样本。'
      return { text: `${id}：${saved.stage}\n${tail}` }
    }
  }))

  // ── 7. 排期发布（只写本地发布包） ──────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'content_publish',
    description:
      '把审查通过的条目登记成发布包（平台、账号、时间、AI 标注），推进到 published。本工具不接触任何平台接口：真正的发布由你本人或平台自带的排期功能完成。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '条目 id' },
        platform: { type: 'string', enum: PLATFORMS, description: '目标平台' },
        account: { type: 'string', description: '账号，例如 @xxx（一个平台只挂一个账号）' },
        scheduledAt: { type: 'string', description: '计划发布时间，ISO 字符串' },
        aiLabeled: { type: 'boolean', description: '是否按平台要求标注 AI 生成内容' }
      },
      required: ['id', 'platform', 'account']
    },
    async run(args) {
      const id = assertItemId(args.id)
      const item = await readItem(id)
      if (item.stage !== 'queued') {
        throw new Error(`条目 ${id} 在 ${item.stage} 阶段，只有 queued 能排期（先过人工闸门）`)
      }
      if (item.gate?.decision !== 'approve' || !item.gate?.by) {
        throw new Error(`条目 ${id} 没有人工放行记录，拒绝排期。这是硬规则，不是建议。`)
      }
      const platform = PLATFORMS.includes(args.platform) ? args.platform : null
      if (platform === null) throw new Error(`平台只支持 ${PLATFORMS.join(' / ')}`)
      const account = requireText(args.account, 'account')
      const scheduledAt = String(args.scheduledAt ?? new Date().toISOString())
      const publishHour = hourAsWritten(scheduledAt)
      const publish = {
        id,
        target: { platform, account, scheduledAt, aiLabeled: args.aiLabeled === true },
        preparedAt: new Date().toISOString(),
        note: '本地发布包。本插件不代发：发布是不可逆动作，必须由人完成。'
      }
      await writeFile(publishPath(id), `${JSON.stringify(publish, null, 2)}\n`, 'utf8')
      const targets = [...(item.targets ?? []).filter((row) => row.platform !== platform), publish.target]
      const saved = await saveItem({
        ...item,
        targets,
        features: {
          ...item.features,
          publishHour: publishHour === null ? item.features.publishHour : publishHour
        }
      }, { from: item.stage, to: 'published', actor: '发布', reason: `排期 ${platform}` , evidence: [publishPath(id)] })
      return {
        text: `发布包已就绪：${publishPath(id)}\n${saved.id} → published（${platform}／${account}／${scheduledAt}）\n提醒：${args.aiLabeled === true ? '已标 AI 内容，符合平台要求。' : '没标 AI 内容——若平台要求标注，这是封号点，去补上。'}\n真正发布请你本人操作，或交给平台原生排期。`,
        costFor: id, costStage: 'published'
      }
    }
  }))

  // ── 8. 回采（阿析） ────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'metrics_pull',
    description:
      '回采一条已发布内容的平台数据。特征在第一次回采时被冻结，之后改特征也不会影响归因——所以发布后别改特征，改了也白改。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '条目 id' },
        platform: { type: 'string', enum: PLATFORMS, description: '平台' },
        views: { type: 'integer', description: '播放量' },
        likes: { type: 'integer', description: '点赞' },
        comments: { type: 'integer', description: '评论' },
        shares: { type: 'integer', description: '转发' },
        saves: { type: 'integer', description: '收藏' },
        revenueUsd: { type: 'number', description: '该平台折算收入（美元），没有就省略' },
        revenueSource: { type: 'string', enum: ['manual', 'api', 'none'], description: '数据来源：手工抄 / 接口 / 无收入' }
      },
      required: ['id', 'platform', 'views']
    },
    async run(args) {
      const id = assertItemId(args.id)
      const item = await readItem(id)
      const merged = await recordMetrics(id, {
        platform: args.platform,
        views: Number(args.views),
        likes: Number(args.likes ?? 0),
        comments: Number(args.comments ?? 0),
        shares: Number(args.shares ?? 0),
        saves: Number(args.saves ?? 0),
        revenueUsd: Number(args.revenueUsd ?? 0),
        revenueSource: ['manual', 'api', 'none'].includes(args.revenueSource) ? args.revenueSource : 'manual',
        item
      })
      let stage = item.stage
      if (item.stage === 'published') {
        stage = (await advance(id, { actor: '阿析', reason: '首次回采完成', expect: 'published' })).stage
      }
      const outcome = merged.outcome
      return {
        text: [
          `${id} 回采完成（${args.platform}）：${outcome.viewsTotal} 播放，收入 $${outcome.revenueUsd}`,
          `成本 ${outcome.tokenCostCny} CNY${outcome.netUsd === null ? '（未设 DSH_USD_CNY，不给净额，避免编汇率）' : `｜净额 $${outcome.netUsd}`}`,
          `阶段：${stage}`
        ].join('\n'),
        costFor: id, costStage: 'measured'
      }
    }
  }))

  // ── 9. 权重表 ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'weights',
    description:
      '看或重算历史权重表（中位数比值，不训练）。read 给阿筛当先验；update 从现有回采数据重算。样本不够时表是空的——空表就是空表，不要据此下结论。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['read', 'update'], description: 'read 看表 / update 重算' },
        minSamples: { type: 'integer', description: '每个桶最少几条才算数，默认 5' }
      },
      required: ['action']
    },
    async run(args) {
      if (args.action === 'update') {
        const minSamples = Number.isSafeInteger(args.minSamples) && args.minSamples > 0 ? args.minSamples : 5
        const weights = await refreshWeights({ minSamples })
        return { text: `权重表已重算。\n${formatWeights(weights)}` }
      }
      return { text: formatWeights(await readWeights()) }
    }
  }))

  // ── 10. 账本 ───────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'cost_report',
    description: '看本地账本和队列成本：今天花了多少、这条流水线一共花了多少。覆盖 token 钱是唯一 KPI，先看数再干活。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async run() {
      const usage = await readUsage()
      const rows = (await Promise.all((await listQueue({ stage: null, limit: 200 })).map((row) => readItemOrNull(row.id)))).filter(Boolean)
      const summary = summarizeCost(rows)
      const byStage = Object.entries(summary.byStage).map(([stage, count]) => `${stage} ${count}`).join('｜')
      return { text: `${formatUsage(usage)}\n\n队列成本：${summary.count} 条｜${summary.tokens} tokens｜${summary.cny} CNY\n阶段分布：${byStage || '空'}` }
    }
  }))
}

function upsertArtifact(list, artifact) {
  const rest = (Array.isArray(list) ? list : []).filter((row) => row?.kind !== artifact.kind)
  const bytes = Number.isFinite(artifact.bytes) ? artifact.bytes : undefined
  return [...rest, bytes === undefined ? artifact : { ...artifact, bytes }]
}
