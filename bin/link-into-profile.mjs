#!/usr/bin/env node
// 把本插件挂进某个 dsh profile（默认 desktop）。
//
//   node bin/link-into-profile.mjs                  # 装进 desktop profile
//   node bin/link-into-profile.mjs --profile web    # 装进 web profile
//   node bin/link-into-profile.mjs --symlink-only   # 只建软链，不改 package.json
//   node bin/link-into-profile.mjs --remove         # 卸掉
//
// 做的事只有三件，每一步都打印出来，随时可手工核对：
//   1) profile 的 package.json：加一条 link: 依赖 + 把插件名追加进 dsh.profile.bundles
//   2) profile 的 node_modules：建软链，让插件立刻可解析
//   3) $DSH_HOME/team/：放一份 employees.json 花名册样例（已存在则不动）

import { copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-team-employees'
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const profile = valueOf('--profile', 'desktop')
const remove = has('--remove')
const symlinkOnly = has('--symlink-only')
const dryRun = has('--dry-run')

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = path.join(dshHome, 'profiles', profile)
const manifestPath = path.join(profileDir, 'package.json')
const modulePath = path.join(profileDir, 'node_modules', PACKAGE_NAME)
const teamDir = path.join(dshHome, 'team')

const log = (...parts) => console.log(...parts)

async function readManifest() {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`没有找到 ${manifestPath}\n先正常启动一次 profile「${profile}」，让它自己把 profile 建出来，再跑本脚本。`)
    }
    throw error
  }
}

function addToManifest(manifest) {
  const changes = []
  manifest.dependencies ??= {}
  if (manifest.dependencies[PACKAGE_NAME] === undefined) {
    if (symlinkOnly) {
      changes.push('跳过 package.json 依赖（--symlink-only）')
    } else {
      manifest.dependencies[PACKAGE_NAME] = `link:${PACKAGE_ROOT}`
      changes.push(`dependencies += "${PACKAGE_NAME}": "link:${PACKAGE_ROOT}"`)
    }
  }
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles ??= []
  if (!manifest.dsh.profile.bundles.includes(PACKAGE_NAME)) {
    manifest.dsh.profile.bundles.push(PACKAGE_NAME)
    changes.push(`dsh.profile.bundles += "${PACKAGE_NAME}"（追加在末尾）`)
  }
  return changes
}

function removeFromManifest(manifest) {
  const changes = []
  if (manifest.dependencies?.[PACKAGE_NAME] !== undefined) {
    delete manifest.dependencies[PACKAGE_NAME]
    changes.push(`dependencies -= "${PACKAGE_NAME}"`)
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)) {
    manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== PACKAGE_NAME)
    changes.push(`dsh.profile.bundles -= "${PACKAGE_NAME}"`)
  }
  return changes
}

async function writeManifest(manifest) {
  if (dryRun) return
  const backupPath = `${manifestPath}.team.bak`
  try {
    await readFile(backupPath)
  } catch {
    await copyFile(manifestPath, backupPath)
    log(`  已备份原始配置 → ${backupPath}`)
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

async function link() {
  if (dryRun) return
  await mkdir(path.dirname(modulePath), { recursive: true })
  await rm(modulePath, { recursive: true, force: true })
  await symlink(PACKAGE_ROOT, modulePath, 'dir')
}

async function seedRoster() {
  const target = path.join(teamDir, 'employees.json')
  try {
    await readFile(target)
    log(`  花名册已存在，保留不动 → ${target}`)
    return
  } catch {
    // 继续：下面写入样例
  }
  if (dryRun) {
    log(`  （dry-run 未写入）将会放置花名册样例 → ${target}`)
    return
  }
  await mkdir(teamDir, { recursive: true })
  await copyFile(path.join(PACKAGE_ROOT, 'employees.json'), target)
  log(`  已放置花名册样例 → ${target}`)
}

const manifest = await readManifest()
log(`profile：${profileDir}`)

if (remove) {
  const changes = removeFromManifest(manifest)
  await writeManifest(manifest)
  await rm(modulePath, { recursive: true, force: true })
  log(changes.length > 0 ? `  已撤销：\n    - ${changes.join('\n    - ')}` : '  package.json 里本来就没有本插件')
  log(`  已移除软链：${modulePath}`)
  log('\n重启 DSH 后生效。')
} else {
  const changes = addToManifest(manifest)
  await writeManifest(manifest)
  const verb = dryRun ? '将会改动' : '已改动'
  log(changes.length > 0 ? `  ${verb}：\n    - ${changes.join('\n    - ')}` : '  package.json 无需改动（已装过）')
  await link()
  log(dryRun
    ? `  （dry-run 未写入）将会建软链 → ${modulePath}`
    : `  已建软链：${modulePath} -> ${PACKAGE_ROOT}`)
  await seedRoster()
  log('\n重启 DSH（完全退出再打开）后生效。验证：新建会话 → 模式下拉出现「情报员工·阿研」「审核员工·阿审」。')
  log(`团队面板：浏览器打开 ${process.env.DSH_WEB_URL || 'http://127.0.0.1:19387'}/team`)
}
