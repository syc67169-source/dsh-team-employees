// Agent 平面：员工在会话里能用的团队工具。
//
// 这里用 ctx.tools.register() 的原始定义对象，不用 @deepseek-ai/dsh-tools 的
// defineTool —— 少一个运行时版本依赖，注册契约不变（name / description /
// parameters(JSON Schema) / output{schema,render} / execute）。

import {
  appendJournal, formatJournal, formatRoster, readJournal, readRoster, journalPath, rosterPath
} from './store.mjs'

export const name = 'team-employees/tools'
export const inject = ['tools']

/** 所有工具共用的输出形状：一行文本。 */
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

export function apply(ctx) {
  ctx.tools.register({
    name: 'team_roster',
    description:
      '查看团队花名册：谁在岗、什么岗位、绑哪个模式、用哪个模型。不确定该找谁时先调用它。省略参数看全队，带 id 或名字看单人。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '员工 id 或名字；省略则列出全队' }
      }
    },
    output: output(),
    async execute(args) {
      const roster = await readRoster()
      const filter = typeof args?.id === 'string' ? args.id : null
      return { text: `${formatRoster(roster, filter)}\n\n花名册文件：${rosterPath()}` }
    }
  })

  ctx.tools.register({
    name: 'team_log',
    description:
      '把当前这一步的结论写进团队共享工作日志，供其他员工和用户看到。做完一段工作就写一条；卡住了也要写，写清卡在哪。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        employee: { type: 'string', description: '汇报人：你自己的名字或 id' },
        summary: { type: 'string', description: '一句话说清做了什么、结论是什么' },
        status: { type: 'string', enum: ['进行中', '完成', '卡住'], description: '这一步的状态' },
        artifacts: {
          type: 'array',
          items: { type: 'string' },
          description: '产出的文件路径列表，没有就省略'
        }
      },
      required: ['employee', 'summary']
    },
    output: output(),
    async execute(args) {
      const summary = String(args?.summary ?? '').trim()
      if (summary.length === 0) throw new Error('team_log 需要 summary：一句话说清这一步做了什么')
      const line = await appendJournal({
        employee: String(args?.employee ?? '未署名').trim(),
        summary,
        status: typeof args?.status === 'string' && args.status.length > 0 ? args.status : '进行中',
        artifacts: Array.isArray(args?.artifacts) ? args.artifacts.map(String) : []
      })
      return { text: `已写入团队日志：${line}\n日志文件：${journalPath()}` }
    }
  })

  ctx.tools.register({
    name: 'team_inbox',
    description:
      '看团队最近的工作日志：别人做到哪了、有没有卡住、产出了什么。接手别人活儿之前先调用它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', description: '看最近几条，默认 20' }
      }
    },
    output: output(),
    async execute(args) {
      const entries = await readJournal(Number.isSafeInteger(args?.limit) ? args.limit : 20)
      return { text: `${formatJournal(entries)}\n\n日志文件：${journalPath()}` }
    }
  })
}
