#!/usr/bin/env node
// 把预览 HTML 截成 README 用的 PNG。
//
//   node tools/screenshot.mjs            # 渲染并截图，写到 docs/images/
//
// 需要本机有 Chrome / Chromium / Edge 之一（macOS 与 Linux 的常见位置都试）。
// 没有就明确说一声跳过——图片已经在仓库里了，不影响别人使用。

import { access, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]

// 高度按内容给：多了会留一大片空白，少了会把最后一行切掉
const SHOTS = [
  { surface: 'office', height: 880 },
  { surface: 'settings', height: 830 }
]

async function findBrowser() {
  for (const candidate of BROWSERS) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // 接着试下一个
    }
  }
  return null
}

const browser = await findBrowser()
if (browser === null) {
  console.log('没找到 Chrome / Chromium / Edge，跳过截图。图片已在 docs/images/ 里，需要重截时再装一个浏览器。')
  process.exit(0)
}

await mkdir(path.join(ROOT, 'docs/images'), { recursive: true })

for (const shot of SHOTS) {
  await run(process.execPath, [path.join(ROOT, 'tools/preview.mjs'), `--only=${shot.surface}`])
  const source = `file://${path.join(ROOT, `docs/preview-${shot.surface}.html`)}`
  const target = path.join(ROOT, `docs/images/${shot.surface}.png`)
  await run(browser, [
    '--headless', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1.6',
    `--window-size=1240,${shot.height}`,
    `--screenshot=${target}`, source
  ])
  console.log(`已截图：docs/images/${shot.surface}.png`)
}
