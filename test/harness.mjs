// 找本机的 dsh 运行时：自检要借它真正的 schema 校验器，才能验证
// 「工具注册契约」不是我们自己以为的那样。
//
// 找不到就整体降级：结构类断言照跑，schema 类断言跳过并明确说出来，
// 而不是把测试写死在某台机器的安装路径上。

import { access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const TOOLS_SUBPATH = 'node_modules/@deepseek-ai/dsh-tools/lib/index.js'

/** 常见安装形态。按顺序试，第一个存在的就用它。 */
function candidates() {
  const list = []
  if (process.env.DSH_TOOLS_ENTRY) list.push(process.env.DSH_TOOLS_ENTRY)
  const roots = [
    '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh',
    path.join(os.homedir(), 'Applications/DeepSeek Harness.app/Contents/Resources/app/dsh'),
    '/opt/DeepSeek Harness/resources/app/dsh'
  ]
  for (const root of roots) list.push(path.join(root, TOOLS_SUBPATH))
  if (process.env.DSH_INSTALL_ROOT) list.push(path.join(process.env.DSH_INSTALL_ROOT, TOOLS_SUBPATH))
  return list
}

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/** @returns dsh-tools 的入口绝对路径，找不到返回 null。 */
export async function locateToolsEntry() {
  // DSH_TOOLS_ENTRY=off 强制走「没装 dsh」的分支，用来验证降级路径本身没坏
  if (process.env.DSH_TOOLS_ENTRY === 'off') return null
  for (const candidate of candidates()) {
    if (candidate && await exists(candidate)) return candidate
  }
  return null
}

export const toolsEntry = await locateToolsEntry()

/** 该安装的 node_modules 根目录（用于核对包是否存在）。 */
export const nodeModulesRoot = toolsEntry === null
  ? null
  : path.resolve(path.dirname(toolsEntry), '../../..')

/** dsh-tools 的导出；没装 dsh 时为 null。 */
export const toolsApi = toolsEntry === null ? null : await import(toolsEntry)

/** 说明当前是「真校验」还是「跳过」，由自检打印出来。 */
export const harnessNote = toolsEntry === null
  ? '（跳过 schema 校验：本机没找到 dsh 安装，可设 DSH_TOOLS_ENTRY 指定）'
  : `（schema 校验用：${toolsEntry}）`
