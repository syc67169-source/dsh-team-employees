import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const held = new AsyncLocalStorage()

/** Locks are shared by all processes using the same data directory. */
export async function withFileLock(file, run, { timeoutMs = 15000 } = {}) {
  const key = path.resolve(file)
  if (held.getStore()?.has(key)) return run()
  await mkdir(path.dirname(key), { recursive: true })
  const lock = `${key}.lock`
  const token = randomUUID()
  const started = Date.now()
  while (true) {
    try {
      // No await between creating the directory and writing its owner.
      mkdirSync(lock)
      try { writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token })) }
      catch (error) { await rm(lock, { recursive: true, force: true }); throw error }
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // Never reclaim automatically: a check followed by unlink can remove a
      // different process's newly acquired lock. A crashed owner's lock is
      // reported for recovery after stopping all writers.
      if (Date.now() - started >= timeoutMs) throw new Error(`等待数据锁超时：${key}；若进程已退出，请关闭所有写入进程后移除 ${lock} 再重试`)
      await delay(15 + Math.random() * 20)
    }
  }
  try {
    return await held.run(new Set([...(held.getStore() ?? []), key]), run)
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

/** Unique temporary files plus atomic rename; callers lock read-modify-write. */
export async function writeJsonAtomic(file, value) {
  return writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

export async function writeTextAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temp, text, { encoding: 'utf8', flag: 'wx' })
    await rename(temp, file)
  } finally {
    await rm(temp, { force: true })
  }
}
