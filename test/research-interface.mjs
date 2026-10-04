import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import vm from 'node:vm'
import { createMiniReact, treeText } from './mini-react.mjs'

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-research-interface-'))
process.env.DSH_TEAM_ROOT = root
await writeFile(path.join(root, 'employees.json'), JSON.stringify({ employees: [{ id: 'scout', name: '阿研', role: '资讯研究' }] }))
const store = await import('../lib/research-store.mjs')
let handler
const services = { connection: { requestRejection: () => undefined } }
const ctx = { get: name => services[name], effect: fn => fn(), webServer: { register: row => { handler = row.handler } } }
;(await import('../lib/index.js')).apply({ inject: (_, fn) => fn(ctx) })
const human = { 'x-dsh-team-action': 'human', origin: 'dsh-app://app' }
async function call(method, url, body, headers = human) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
  Object.assign(req, { method, url, headers })
  let status, text
  await handler(req, { writeHead: value => { status = value }, end: value => { text = value } })
  return { status, text, json: () => JSON.parse(text) }
}
let goal
const input = { action: 'create', title: '资讯职责', objective: '跟踪新增功能', sources: ['https://example.com/'], employee: 'scout' }
after(async () => rm(root, { recursive: true, force: true }))

test('responsibility API requires host auth and same-origin human header', async () => {
  assert.equal((await call('POST','/team/research',input,{})).status,403)
  assert.equal((await call('POST','/team/research',input,{...human,origin:'https://evil.test'})).status,403)
  services.connection = undefined
  assert.equal((await call('GET','/team/research')).status,503)
  assert.equal((await call('GET','/team/api')).status,503)
  services.connection = {requestRejection:()=>401}
  assert.equal((await call('POST','/team/research',input)).status,401)
  services.connection = {requestRejection:()=>undefined}
})
test('API creates paused goal, runs once, pauses and does not spawn test workers', async () => {
  const result = await call('POST','/team/research',input)
  assert.equal(result.status,200); goal=result.json().result
  assert.equal(goal.enabled,false)
  assert.equal((await call('POST','/team/research',{action:'run-once',id:goal.id})).status,200)
  assert.equal((await store.readResearch()).goals[0].manualPending,true)
  await call('POST','/team/research',{action:'pause',id:goal.id})
  assert.equal((await store.readResearch()).goals[0].manualPending,false)
  const snapshot = (await call('GET','/team/api')).json()
  assert.equal(snapshot.research.goals.length,1);assert.equal(snapshot.research.worker.online,false)
})
test('first version prevents a second enabled responsibility and invalid actions',async()=>{
  const second=(await call('POST','/team/research',{...input,title:'second'})).json().result
  await call('POST','/team/research',{action:'enable',id:goal.id})
  assert.equal((await call('POST','/team/research',{action:'enable',id:second.id})).status,400)
  assert.equal((await call('POST','/team/research',{action:'unknown',id:goal.id})).status,400)
  await call('POST','/team/research',{action:'pause',id:goal.id})
})
test('report route serves only completed known UUID runs, never arbitrary paths',async()=>{
  const run='00000000-0000-4000-8000-000000000001'
  assert.equal((await call('GET',`/team/research/report?id=${goal.id}&run=${run}`)).status,404)
  const dir=path.join(store.researchRoot(),'runs',goal.id,run)
  await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'report.md'),'fixture successful report')
  await store.updateResearch(state=>{state.goals[0].runs.push({id:run,status:'success'})})
  const response=await call('GET',`/team/research/report?id=${goal.id}&run=${run}`)
  assert.equal(response.status,200);assert.equal(response.text,'fixture successful report')
  assert.equal((await call('GET',`/team/research/report?id=${goal.id}&run=../../employees.json`)).status,404)
})

const react=createMiniReact();let bundle
vm.runInNewContext(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'),{
 window:{__ModuleLoader__:{load:row=>{bundle=row}}},fetch:async()=>({ok:true,status:200,text:async()=>JSON.stringify({team:'test',employees:[{id:'scout',name:'阿研',role:'资讯研究'}],research:{goals:[],notices:[],worker:{online:true}},office:null,content:null})})
})
let page
bundle.factory(()=>react).apply({slots:{inject:(_,fn)=>fn(),register:(spec,component)=>{if(spec.name==='main')page=component}}})
function find(node,name) {
 if(!node)return null
 if(Array.isArray(node))return node.map(row=>find(row,name)).find(Boolean)
 if(typeof node.type==='function'&&node.type.name===name)return node.type
 return find(node.props?.children,name)
}
let Panel
test('office exposes research panel and honest local-running empty state',async()=>{
 Panel=find(await react.mount(page,{}),'ResearchPanel')
 assert.ok(Panel)
 const tree=await react.mount(Panel,{data:{research:{goals:[],worker:{online:true}},employees:[{id:'scout',name:'阿研'}]}})
 assert.match(treeText(tree),/长期研究员工/);assert.match(treeText(tree),/本地后台在线/);assert.match(treeText(tree),/电脑须保持运行/);assert.match(treeText(tree),/还没有长期职责/)
})
test('panel displays successful memory, latest failure, notices and meaningful controls',async()=>{
 const tree=await react.mount(Panel,{data:{research:{worker:{online:true},goals:[{...goal,status:'needs-attention',usage:{day:'2026-10-04',calls:3},memory:{summary:'fixture brief',at:'2026-10-04T00:00:00Z',runId:'run-1'},runs:[{id:'run-1',startedAt:'2026-10-04T00:00:00Z',status:'failed',error:'fixture error'}]}],notices:[{id:'notice',at:'2026-10-04T00:00:00Z',message:'changed sources',read:false}]}}})
 const rendered=treeText(tree)
 for(const text of ['需要处理','fixture brief','fixture error','changed sources','立即执行一次','启用定时职责','暂停 / 停止'])assert.ok(rendered.includes(text),text)
})
