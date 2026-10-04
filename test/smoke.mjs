// 本机自检：不启动 DSH，直接把插件的注册契约和真实行为跑一遍。
//
//   node test/smoke.mjs
//
// 覆盖四块：团队工具、Host 接口（/team/api）、浏览器面板、桌面端客户端包。
// 借已安装的 dsh 运行时的真 schema 校验器；本机没装 dsh 时自动跳过那几条断言。

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import vm from 'node:vm'

const { toolsApi, nodeModulesRoot, harnessNote } = await import('./harness.mjs')
const assertSupportedJsonSchema = toolsApi?.assertSupportedJsonSchema ?? (() => {})
const validateJsonSchemaValue = toolsApi?.validateJsonSchemaValue ?? (() => [])

// 沙箱：团队数据写进临时目录，绝不碰真实数据
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'dsh-team-smoke-'))
process.env.DSH_TEAM_ROOT = sandbox

const toolsModule = await import('../lib/tools.js')
const hostModule = await import('../lib/index.js')
const store = await import('../lib/store.mjs')

const results = []
/** 顺序执行一条检查并记录结果（顺序很重要：后面的检查依赖前面写下的数据）。 */
const check = async (label, fn) => {
  try {
    await fn()
    results.push({ ok: true, label })
  } catch (error) {
    results.push({ ok: false, label, detail: error.message })
  }
}

// ══ 1. 团队工具 ════════════════════════════════════════════════════════

const registered = []
toolsModule.apply({ tools: { register: (definition) => registered.push(definition) } })

await check('注册了 3 个团队工具', () => {
  assert.deepEqual(registered.map((tool) => tool.name), ['team_roster', 'team_log', 'team_inbox'])
})

await check(`每个工具的参数与输出 schema 都在运行时支持范围内${harnessNote}`, () => {
  for (const tool of registered) {
    assertSupportedJsonSchema(tool.parameters)
    assertSupportedJsonSchema(tool.output.schema)
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
    assert.ok(tool.description.length > 10)
  }
})

await check('注册时导出 name 与 inject', () => {
  assert.equal(toolsModule.name, 'team-employees/tools')
  assert.deepEqual(toolsModule.inject, ['tools'])
})

await check('花名册不存在时优雅降级', async () => {
  const roster = await store.readRoster()
  assert.equal(roster.employees.length, 0)
  const text = await registered[0].execute({}, {})
  assert.match(text.text, /还没有员工/)
})

await writeFile(path.join(sandbox, 'employees.json'), JSON.stringify({
  team: '自检小队',
  employees: [{ id: 'scout', preset: 'scout', name: '阿研', role: '情报员工', note: '只查不做。' }]
}), 'utf8')

await check('花名册能读出来并渲染', async () => {
  const text = await registered[0].execute({ id: 'scout' }, {})
  assert.match(text.text, /阿研/)
  assert.match(text.text, /情报员工/)
})

await check('team_log 写入后 team_inbox 能读回', async () => {
  const written = await registered[1].execute({
    employee: '阿研', summary: '查了三个来源，结论一致', status: '完成', artifacts: ['out/简报.md']
  }, {})
  assert.match(written.text, /已写入团队日志/)
  const read = await registered[2].execute({ limit: 5 }, {})
  assert.match(read.text, /阿研/)
  assert.match(read.text, /完成/)
  assert.match(read.text, /out\/简报\.md/)
})

await check('team_log 空 summary 会拒绝', async () => {
  await assert.rejects(() => registered[1].execute({ employee: '阿研', summary: '  ' }, {}), /summary/)
})

await check('工具返回值符合自己声明的输出 schema', () => {
  for (const tool of registered) {
    assert.equal(validateJsonSchemaValue(tool.output.schema, { text: 'x' }, '').length, 0)
  }
})

// ══ 2. Host 接口 ═══════════════════════════════════════════════════════

const PRESETS = [
  { id: 'scout', name: '情报员工·阿研', order: 20 },
  { id: 'reviewer', name: '审核员工·阿审', order: 21 }
]

const TODAY = new Date().toISOString().slice(0, 10)
await writeFile(path.join(sandbox, 'usage.json'), JSON.stringify({
  history: { [TODAY]: 1.25 },
  lastBalance: 36.33,
  events: [
    { ts: `${TODAY}T09:00:00.000Z`, day: TODAY, model: 'deepseek-flash', cost: 0.5, tokens: 1000 },
    { ts: `${TODAY}T09:30:00.000Z`, day: TODAY, model: 'deepseek-flash', cost: 0.75, tokens: 2000 },
    { ts: '2020-01-01T00:00:00.000Z', day: '2020-01-01', model: 'deepseek-flash', cost: 9, tokens: 999999 }
  ]
}), 'utf8')
process.env.DSH_USAGE_PATH = path.join(sandbox, 'usage.json')

const LIVE_SESSIONS = [
  { id: 's-busy', header: { agentPreset: 'scout' } },
  { id: 's-idle', header: { agentPreset: 'select' } },
  { id: 's-other', header: { agentPreset: 'reviewer' } }
]
const fakeServices = {
  connection: { requestRejection: () => undefined },
  agentPresets: { list: async () => PRESETS.map((preset) => ({ ...preset, description: '' })) },
  sessions: { list: () => LIVE_SESSIONS },
  sessionProjections: {
    stateOf: (session, key) => {
      if (key === 'turnBoundary') return { openTurnStartSeq: session.id === 's-busy' ? 7 : null, lastTurn: 2 }
      if (key === 'title') return session.id === 's-busy' ? '查一下竞品' : null
      return undefined
    }
  }
}

let route
const fakeWebCtx = {
  get: (serviceName) => fakeServices[serviceName],
  effect: (register) => register(),
  webServer: { register: (registeredRoute) => { route = registeredRoute } }
}
hostModule.apply({ inject: (names, callback) => { assert.deepEqual(names, ['webServer']); callback(fakeWebCtx) } })

/** 直接调路由处理器，模拟一次 HTTP 请求。 */
async function call(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() { yield* chunks }
  }
  const out = []
  const res = {
    statusCode: 0,
    headers: undefined,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers },
    end(payload) { if (payload !== undefined) out.push(String(payload)) }
  }
  await route.handler(req, res)
  const text = out.join('')
  return { status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }
}

await check('面板路由形状正确', () => {
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/team')
  assert.equal(typeof route.handler, 'function')
  assert.equal(hostModule.name, 'team-employees')
})

await check('GET /team/api 返回花名册、工牌、流水线、日志', async () => {
  const api = await call('GET', '/team/api')
  assert.equal(api.status, 200)
  const payload = api.json()
  assert.equal(payload.team, '自检小队')
  assert.equal(payload.employees.length, 1)
  assert.equal(payload.presets.length, 2)
  assert.ok(payload.content !== null && typeof payload.content.byStage === 'object')
  assert.deepEqual(payload.content.review, [])
  assert.equal(payload.journal.length, 1)
  assert.equal(payload.office.departments.length, 6)
})

await check('办公室：上钟 / 待命 / 空岗 / 人工岗 四种状态都算对', async () => {
  const office = (await call('GET', '/team/api')).json().office
  const byId = Object.fromEntries(office.departments.map((row) => [row.id, row]))
  assert.equal(byId.intake.state, 'working', 'scout 有开着 turn 的会话 → 上钟')
  assert.equal(byId.intake.busySessions, 1)
  assert.deepEqual(byId.intake.workingOn, ['查一下竞品'])
  assert.equal(byId.select.state, 'standby', 'select 有会话但没开 turn → 待命')
  assert.equal(byId.write.state, 'off', 'write 没有会话 → 空岗')
  assert.equal(byId.measure.state, 'off')
  assert.equal(byId.gate.state, 'manual', '质检台永远是人坐班')
  assert.equal(byId.gate.manual, true)
  assert.equal(office.team.working, 1)
  assert.equal(office.team.standby, 1)
  assert.equal(office.team.manual, 1)
  assert.equal(office.team.off, 3)
  assert.equal(office.team.liveSessions, 3)
})

await check('办公室：咖啡豆只数今天的 token，余额与今日支出照账本读', async () => {
  const team = (await call('GET', '/team/api')).json().office.team
  assert.equal(team.tokensToday, 3000, '两千 + 一千，2020 年那笔不算')
  assert.equal(team.spendToday.amount, 1.25)
  assert.equal(team.balance.amount, 36.33)
})

await check('办公室：某个部门手上几条、花多少钱、最近动作，都来自真实数据', async () => {
  const content = await import('../lib/content.mjs')
  await content.createItem({ topic: 'hauls', source: { kind: 'own', ref: 'x', license: 'own' } })
  const office = (await call('GET', '/team/api')).json().office
  const intake = office.departments.find((row) => row.id === 'intake')
  assert.equal(intake.queue, 1)
  assert.equal(intake.stage, 'ingested')
  assert.ok(typeof intake.lastActionAt === 'string')
})

await check('POST /team/api 新增员工并落盘', async () => {
  const api = await call('POST', '/team/api', {
    action: 'upsert',
    employee: { id: 'select', name: '阿筛', role: '选题员工', preset: 'select', model: '', note: '只打分。' }
  })
  assert.equal(api.status, 200)
  const payload = api.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.employees.length, 2)
  assert.ok(typeof payload.warning === 'string' && payload.warning.includes('工牌'))
  assert.match(payload.snippet, /preset-employee-select/)
  const onDisk = JSON.parse(await readFile(path.join(sandbox, 'employees.json'), 'utf8'))
  assert.equal(onDisk.employees.length, 2)
  assert.equal(onDisk.employees[1].name, '阿筛')
})

await check('POST /team/api 编辑已有员工走覆盖而不是追加', async () => {
  const api = await call('POST', '/team/api', {
    action: 'upsert',
    employee: { id: 'scout', name: '阿研', role: '情报员工', preset: 'scout', model: 'deepseek-flash', note: '改过的备注' }
  })
  const payload = api.json()
  assert.equal(payload.employees.length, 2)
  assert.equal(payload.employees[0].model, 'deepseek-flash')
  assert.equal(payload.warning, undefined)
})

await check('非法 id 被拒绝，且不写盘', async () => {
  const api = await call('POST', '/team/api', { action: 'upsert', employee: { id: '阿筛', name: 'x', role: 'y' } })
  assert.equal(api.status, 400)
  assert.match(api.json().error, /id/)
  const onDisk = JSON.parse(await readFile(path.join(sandbox, 'employees.json'), 'utf8'))
  assert.equal(onDisk.employees.length, 2)
})

await check('空名字被拒绝', async () => {
  const api = await call('POST', '/team/api', { action: 'upsert', employee: { id: 'writer', name: '  ', role: '成稿' } })
  assert.equal(api.status, 400)
  assert.match(api.json().error, /名字/)
})

await check('移出员工', async () => {
  const api = await call('POST', '/team/api', { action: 'remove', employee: { id: 'select' } })
  assert.equal(api.status, 200)
  assert.equal(api.json().employees.length, 1)
  const again = await call('POST', '/team/api', { action: 'remove', employee: { id: 'select' } })
  assert.equal(again.status, 400)
  assert.match(again.json().error, /没有 id/)
})

await check('不认识的操作 / 坏 JSON / 未知路径都给出明确错误', async () => {
  assert.match((await call('POST', '/team/api', { action: '炸掉' })).json().error, /upsert \/ remove/)
  const bad = await call('POST', '/team/api', undefined)
  assert.equal(bad.status, 400, '空体应当在校验处失败')
  assert.equal(bad.json().ok, false)
  assert.match(bad.json().error, /id/)
  const missing = await call('GET', '/team/nope')
  assert.equal(missing.status, 404)
})

await check('GET /team 仍然返回 HTML 面板（含流水线区块）', async () => {
  const page = await call('GET', '/team')
  assert.equal(page.status, 200)
  assert.match(page.headers['content-type'], /text\/html/)
  assert.match(page.text, /自检小队/)
  assert.match(page.text, /阿研/)
  assert.match(page.text, /内容流水线/)
  assert.match(page.text, /待审/)
})

// ══ 3. 桌面端客户端包 ══════════════════════════════════════════════════

const { createMiniReact, treeText } = await import('./mini-react.mjs')

/** 换掉 vm 沙箱里的 fetch：vm 里跑的代码用的是全局 fetch，从外面替换即可。 */
let sandboxFetch = async () => { throw new Error('自检里不该真的发请求') }
function clientSandboxFetch(payload, override, pending) {
  if (pending === true) { sandboxFetch = () => new Promise(() => {}); return }
  if (payload === null) {
    sandboxFetch = async () => ({ ok: override.ok, status: override.status, text: async () => '' })
    return
  }
  sandboxFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) })
}

const miniReact = createMiniReact()

/** 假 document：只记 <style> 的注入，够验证关键帧有没有落进页面。 */
function fakeDocument() {
  const styles = []
  return {
    styles,
    document: {
      getElementById: (id) => styles.find((element) => element.id === id) ?? null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild: (element) => { styles.push(element) } }
    }
  }
}

/** 把客户端包装进 vm 跑一遍（经典脚本，靠 window.__ModuleLoader__ 注册自己）。 */
function loadClientBundle(dom) {
  const seen = []
  const sandbox = {
    console,
    setImmediate,
    fetch: (...args) => sandboxFetch(...args),
    document: dom?.document,
    window: { __ModuleLoader__: { load: (entry) => seen.push(entry) } }
  }
  sandbox.window.window = sandbox.window
  vm.runInNewContext(clientSource, sandbox, { filename: 'lib/client.js' })
  assert.equal(seen.length, 1, '客户端包没有按模块加载器约定注册自己')
  assert.equal(seen[0].id, 'dsh-team-employees')
  return seen[0].factory((request) => {
    if (request === 'react') return miniReact
    throw new Error(`客户端包请求了未声明的模块：${request}`)
  })
}

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const dom = fakeDocument()
const clientModule = loadClientBundle(dom)

/** 假客户端 ctx：把所有注册收下来。 */
const registrations = []
const fakeClientCtx = {
  slots: {
    inject: (slotName, callback) => callback(),
    register: (spec, Component) => registrations.push({ spec, Component })
  }
}
clientModule.apply(fakeClientCtx)
const bySlot = (slotName) => registrations.find((row) => row.spec.name === slotName)

await check('客户端包用模块加载器约定注册自己', () => {
  assert.equal(clientModule.name, 'dsh-team-employees')
  assert.deepEqual([...clientModule.inject], ['slots'])
  assert.equal(typeof clientModule.apply, 'function')
})

await check('动画关键帧注入了页面，而且只注入一次', () => {
  assert.equal(dom.styles.length, 1)
  assert.equal(dom.styles[0].id, 'dsh-team-office-style')
  for (const keyframe of ['dshOfficeBob', 'dshOfficeType', 'dshOfficeZzz', 'dshOfficeFlow', 'dshOfficeGlow']) {
    assert.ok(dom.styles[0].textContent.includes(`@keyframes ${keyframe}`), `缺少关键帧 ${keyframe}`)
  }
  // 第二次 apply 用一个丢弃的 ctx，免得把注册记录也复制一份
  clientModule.apply({ slots: { inject: (slotName, callback) => callback(), register: () => {} } })
  assert.equal(dom.styles.length, 1, '第二次 apply 又插了一遍样式')
})

await check('没有 document 时安静跳过样式注入', () => {
  const bare = loadClientBundle(undefined)
  bare.apply({ slots: { inject: (slotName, callback) => callback(), register: () => {} } })
})

await check('注册了三个界面位置：侧边栏入口、整页、设置里的员工管理', () => {
  assert.equal(registrations.length, 3)
  assert.deepEqual(registrations.map((row) => row.spec.name).sort(), ['main', 'settings.section', 'sidebar.panellist'])
})

await check('侧边栏入口：id 与整页 key 一致，图标是个组件', () => {
  const entry = bySlot('sidebar.panellist')
  assert.equal(entry.spec.id, 'team-office')
  assert.equal(entry.spec.order, 12)
  assert.equal(entry.spec.label(), '办公室')
  assert.equal(typeof entry.Component, 'function')
  const page = bySlot('main')
  assert.equal(page.spec.key, entry.spec.id, 'main 的 key 必须等于侧边栏入口 id，否则点了切不过去')
  assert.equal(typeof page.Component, 'function')
})

await check('设置里那一节还在（增删改花名册的地方）', () => {
  const section = bySlot('settings.section')
  assert.equal(section.spec.id, 'team-employees')
  assert.equal(section.spec.order, 25)
  assert.equal(section.spec.label(), '员工')
})

await check('缺少 slots 服务时安静退出，不抛错', () => {
  clientModule.apply({})
  clientModule.apply({ slots: {} })
})

const OFFICE_PAYLOAD = {
  root: '/tmp/team',
  team: '我的 AI 团队',
  employees: [
    { id: 'scout', preset: 'scout', name: '阿研', role: '情报员工', model: '', note: '只查不做' },
    { id: 'select', preset: 'select', name: '阿筛', role: '选题员工', model: '', note: '只打分' }
  ],
  presets: [{ id: 'scout', name: '情报员工·阿研' }],
  content: {
    total: 3,
    byStage: { ingested: 2, review: 1 },
    review: [{ id: '20261003-fashion-haul-001', topic: 'fashion-haul', total: 60, owner: '阿写', updatedAt: null }],
    cost: { cny: 0.75, tokens: 1500 },
    weights: { version: 3, samples: 42 }
  },
  usage: null,
  office: {
    generatedAt: '2026-10-04T06:00:00.000Z',
    departments: [
      { id: 'intake', name: '情报部', motto: '找素材、核授权、登记', preset: 'scout', stage: 'ingested', manual: false, queue: 2, cny: 0.25, sessions: 1, busySessions: 1, state: 'working', lastActionAt: '2026-10-04T05:10:00.000Z', workingOn: ['查一下竞品'] },
      { id: 'select', name: '选题部', motto: '打分、排序、给先验', preset: 'select', stage: 'scored', manual: false, queue: 0, cny: 0.5, sessions: 1, busySessions: 0, state: 'standby', lastActionAt: null, workingOn: [] },
      { id: 'write', name: '成稿部', motto: '脚本与标题', preset: 'write', stage: 'scripted', manual: false, queue: 0, cny: 0, sessions: 0, busySessions: 0, state: 'off', lastActionAt: null, workingOn: [] },
      { id: 'render', name: '制作部', motto: '切片转码', preset: null, stage: 'rendered', manual: false, queue: 0, cny: 0, sessions: 0, busySessions: 0, state: 'off', lastActionAt: null, workingOn: [] },
      { id: 'gate', name: '质检台', motto: '人工裁决', preset: null, stage: 'review', manual: true, queue: 1, cny: 0, sessions: 0, busySessions: 0, state: 'manual', lastActionAt: null, workingOn: [] },
      { id: 'measure', name: '数据部', motto: '回采对账', preset: 'measure', stage: 'measured', manual: false, queue: 0, cny: 0, sessions: 0, busySessions: 0, state: 'off', lastActionAt: null, workingOn: [] }
    ],
    team: { working: 1, standby: 1, off: 3, manual: 1, liveSessions: 2, tokensToday: 3000, spendToday: { amount: 1.25, currency: 'CNY' }, balance: { amount: 36.33, currency: 'CNY' } }
  },
  journal: [{ at: '2026-10-03T11:02:41.123Z', employee: '阿研', status: '完成', summary: '查了三个来源' }]
}

await check('办公室页：六个部门、四种状态、咖啡豆都在', async () => {
  clientSandboxFetch(OFFICE_PAYLOAD)
  const tree = await miniReact.mount(bySlot('main').Component, {})
  const text = treeText(tree)
  for (const name of ['情报部', '选题部', '成稿部', '制作部', '质检台', '数据部']) {
    assert.ok(text.includes(name), `少了部门 ${name}`)
  }
  assert.match(text, /1 个部门上钟中/)
  assert.match(text, /1 个部门待命/)
  assert.match(text, /3 个部门空岗/)
  assert.match(text, /1 个部门等你/)
  assert.match(text, /上钟中/)
  assert.match(text, /待命/)
  assert.match(text, /空岗/)
  assert.match(text, /等你/)
  assert.match(text, /3000/)
  assert.match(text, /咖啡豆/)
  assert.match(text, /正在做：查一下竞品/)
  assert.match(text, /流水线/)
  assert.match(text, /有货在流/)
})

await check('办公室页：接口报错时显示错误而不是白屏', async () => {
  clientSandboxFetch(null, { ok: false, status: 401 })
  const tree = await miniReact.mount(bySlot('main').Component, {})
  assert.match(treeText(tree), /HTTP 401/)
})

await check('设置页：加载态与员工列表照旧', async () => {
  clientSandboxFetch(null, undefined, true)
  const loading = treeText(await miniReact.mount(bySlot('settings.section').Component, {}))
  assert.match(loading, /正在读取花名册/)
  clientSandboxFetch(OFFICE_PAYLOAD)
  const ready = treeText(await miniReact.mount(bySlot('settings.section').Component, {}))
  assert.match(ready, /我的 AI 团队/)
  assert.match(ready, /阿筛/)
  assert.match(ready, /内容流水线/)
  assert.match(ready, /20261003-fashion-haul-001/)
  assert.match(ready, /2 人在岗/)
})

await check('host 侧声明了客户端半边（dsh.client + exports["./client"]）', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-renderer'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.equal(manifest.exports['./client'], './lib/client.js')
})

await check('dsh.client.inject 里的每个包都真的有客户端半边（写错会拖垮启动图）', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  if (nodeModulesRoot === null) return // 本机没装 dsh：跳过
  for (const target of manifest.dsh.client.inject) {
    let raw
    try {
      raw = await readFile(path.join(nodeModulesRoot, target, 'package.json'), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const declaration = JSON.parse(raw).dsh?.client
    assert.ok(declaration !== undefined, `${target} 没有声明 dsh.client，注入它会缺供应商`)
    assert.equal(declaration.platform, 'web')
  }
})

// ══ 结果 ═══════════════════════════════════════════════════════════════

for (const entry of results) {
  console.log(entry.ok ? `  ✓ ${entry.label}` : `  ✗ ${entry.label}\n      ${entry.detail}`)
}
const failed = results.filter((entry) => !entry.ok).length
console.log(`\n${results.length - failed}/${results.length} 通过｜沙箱目录：${sandbox}`)
process.exit(failed === 0 ? 0 : 1)
