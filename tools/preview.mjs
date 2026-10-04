#!/usr/bin/env node
// 把客户端界面渲染成静态 HTML，方便不启动 DSH 也能看设计。
//
//   node tools/preview.mjs                # 三个界面拼一页，写到 docs/preview.html
//   node tools/preview.mjs --only=office  # 只渲染办公室整页，写到 docs/preview-office.html
//   node tools/preview.mjs --only=settings
//
// 用的是同一份 lib/client.js：同一套组件、同一套关键帧 CSS，
// 只是用一个最小 React 运行时把它渲染成字符串，再套上 DSH 的深色底色。

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createMiniReact, toHtml } from '../test/mini-react.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SAMPLE = {
  root: '/Users/you/.dsh/team',
  team: '我的 AI 团队',
  employees: [
    { id: 'scout', preset: 'scout', name: '阿研', role: '情报员工', model: '', note: '只检索、只核实、只出简报' },
    { id: 'select', preset: 'select', name: '阿筛', role: '选题员工', model: '', note: '只打分、只排序' },
    { id: 'write', preset: 'write', name: '阿写', role: '成稿员工', model: '', note: '按分写稿，前三秒钉住人' },
    { id: 'measure', preset: 'measure', name: '阿析', role: '数据员工', model: '', note: '回采、对账、重算权重' }
  ],
  presets: [
    { id: 'scout', name: '情报员工·阿研' }, { id: 'select', name: '选题员工·阿筛' },
    { id: 'write', name: '成稿员工·阿写' }, { id: 'measure', name: '数据员工·阿析' }
  ],
  content: {
    total: 14,
    byStage: { ingested: 3, scored: 2, scripted: 1, review: 4, queued: 2, published: 1, measured: 1 },
    review: [
      { id: '20261004-fashion-haul-007', topic: 'fashion-haul', total: 74, owner: '阿写', updatedAt: '2026-10-04T05:12:00.000Z' },
      { id: '20261004-desk-setup-003', topic: 'desk-setup', total: 61, owner: '阿写', updatedAt: '2026-10-04T04:58:00.000Z' }
    ],
    cost: { cny: 3.86, tokens: 128400 },
    weights: { version: 4, samples: 42 }
  },
  usage: null,
  office: {
    generatedAt: '2026-10-04T05:20:00.000Z',
    departments: [
      { id: 'intake', name: '情报部', motto: '找素材、核授权、登记', preset: 'scout', stage: 'ingested', manual: false, queue: 3, cny: 0.42, sessions: 1, busySessions: 1, state: 'working', lastActionAt: '2026-10-04T05:18:00.000Z', workingOn: ['扒秋冬 haul 素材'] },
      { id: 'select', name: '选题部', motto: '打分、排序、给先验', preset: 'select', stage: 'scored', manual: false, queue: 2, cny: 0.88, sessions: 1, busySessions: 1, state: 'working', lastActionAt: '2026-10-04T05:16:00.000Z', workingOn: ['给 12 条打分'] },
      { id: 'write', name: '成稿部', motto: '脚本与标题', preset: 'write', stage: 'scripted', manual: false, queue: 1, cny: 1.35, sessions: 1, busySessions: 0, state: 'standby', lastActionAt: '2026-10-04T04:40:00.000Z', workingOn: [] },
      { id: 'render', name: '制作部', motto: '切片转码：确定性代码，不烧 token', preset: null, stage: 'rendered', manual: false, queue: 0, cny: 0, sessions: 0, busySessions: 0, state: 'off', lastActionAt: null, workingOn: [] },
      { id: 'gate', name: '质检台', motto: '人工裁决，只有你能放行', preset: null, stage: 'review', manual: true, queue: 4, cny: 0, sessions: 0, busySessions: 0, state: 'manual', lastActionAt: '2026-10-04T04:58:00.000Z', workingOn: [] },
      { id: 'measure', name: '数据部', motto: '回采、对账、重算权重', preset: 'measure', stage: 'measured', manual: false, queue: 0, cny: 1.21, sessions: 0, busySessions: 0, state: 'off', lastActionAt: null, workingOn: [] }
    ],
    team: {
      working: 2, standby: 1, off: 2, manual: 1, liveSessions: 4, tokensToday: 128400,
      spendToday: { amount: 3.86, currency: 'CNY' }, balance: { amount: 32.47, currency: 'CNY' }
    }
  },
  journal: [
    { at: '2026-10-04T05:18:00.000Z', employee: '阿研', status: '完成', summary: '登记 3 条，授权凭证齐全' },
    { at: '2026-10-04T04:58:00.000Z', employee: '阿写', status: '完成', summary: '两条脚本落盘，等质检' }
  ]
}

// ── 跑客户端包 ────────────────────────────────────────────────────────

const styles = []
const documentStub = {
  getElementById: (id) => styles.find((element) => element.id === id) ?? null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild: (element) => { styles.push(element) } }
}

const miniReact = createMiniReact()
const seen = []
const sandbox = {
  console,
  setImmediate,
  document: documentStub,
  fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(SAMPLE) }),
  window: { __ModuleLoader__: { load: (entry) => seen.push(entry) } }
}
sandbox.window.window = sandbox.window
vm.runInNewContext(await readFile(path.join(ROOT, 'lib/client.js'), 'utf8'), sandbox, { filename: 'lib/client.js' })

const client = seen[0].factory((request) => {
  if (request === 'react') return miniReact
  throw new Error(`客户端包请求了未声明的模块：${request}`)
})

const registrations = []
client.apply({ slots: { inject: (slotName, callback) => callback(), register: (spec, Component) => registrations.push({ spec, Component }) } })
const office = registrations.find((row) => row.spec.name === 'main')
const settings = registrations.find((row) => row.spec.name === 'settings.section')
const icon = registrations.find((row) => row.spec.name === 'sidebar.panellist')

const pageHtml = toHtml(await miniReact.mount(office.Component, {}))
const settingsHtml = toHtml(await miniReact.mount(settings.Component, {}))
const iconHtml = toHtml(icon.Component({ size: 18 }))

const only = (process.argv.find((value) => value.startsWith('--only=')) ?? '--only=all').slice('--only='.length)

const shell = (title, body) => `
  <section class="frame">
    <header class="frame-head">${title}</header>
    <div class="frame-body">${body}</div>
  </section>`

const SURFACES = {
  icon: () => shell('侧边栏图标（sidebar.panellist）', `<div style="padding:10px 0;color:#cfd6e0">${iconHtml}</div>`),
  office: () => pageHtml,
  settings: () => settingsHtml
}

const selected = only === 'all' ? Object.keys(SURFACES) : [only]
for (const surface of selected) {
  if (SURFACES[surface] === undefined) throw new Error(`没有叫「${surface}」的界面，可选：${Object.keys(SURFACES).join(' / ')} / all`)
}

const html = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<title>dsh-team-employees 界面预览</title>
<style>
${styles.map((element) => element.textContent).join('\n')}
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin: 0; padding: 28px; background: #14161a; color: #e6e8eb;
         font: 14px/1.6 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif }
  h1 { font-size: 18px; margin: 0 0 4px }
  .note { color: #8b94a3; font-size: 12px; margin-bottom: 24px }
  .frame { border: 1px solid #262b33; border-radius: 12px; overflow: hidden; margin-bottom: 22px; background: #16181d }
  .frame-head { padding: 8px 14px; background: #1b1e24; border-bottom: 1px solid #262b33;
                font-size: 12px; color: #8b94a3; display: flex; gap: 10px; align-items: center }
  .frame-body { padding: 4px 16px 16px }
  code { background: #242830; padding: 1px 6px; border-radius: 4px }
</style></head><body>
  ${only === 'all' ? `<h1>dsh-team-employees 界面预览</h1>
  <div class="note">用同一份 lib/client.js 渲染的静态快照（示例数据）。真机上数据是活的，每 5 秒刷新一次。</div>` : ''}
  ${selected.map((surface) => SURFACES[surface]()).join('\n  ')}
</body></html>
`

const target = path.join(ROOT, only === 'all' ? 'docs/preview.html' : `docs/preview-${only}.html`)
await writeFile(target, html, 'utf8')
console.log(`已生成：${target}`)
