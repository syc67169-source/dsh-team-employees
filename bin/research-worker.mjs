#!/usr/bin/env node
import { startResearchWorker } from '../lib/research-worker.mjs'
import { updateResearch } from '../lib/research-store.mjs'
const args = process.argv.slice(2)
const index = args.indexOf('--root')
if (index >= 0) {
  if (!args[index + 1]) throw new Error('--root 需要团队目录')
  process.env.DSH_TEAM_ROOT = args[index + 1]
}
if (args.includes('--stop')) {
  await updateResearch(state => { if (state.worker) state.worker.stopRequested = true })
  console.log('已请求本地研究后台停止'); process.exit(0)
}
if (args.includes('--help')) {
  console.log('node bin/research-worker.mjs [--root <团队目录>] [--stop]\n本地研究调度进程；电脑必须保持运行。仅处理已启用或手动触发的职责。'); process.exit(0)
}
const controller = new AbortController()
process.on('SIGTERM', () => controller.abort())
process.on('SIGINT', () => controller.abort())
try {
  const result = await startResearchWorker({ signal: controller.signal })
  console.log(result.alreadyRunning ? '研究后台已在运行' : '研究后台已停止')
} catch (error) { console.error(`研究后台异常：${error.message}`); process.exitCode = 1 }
