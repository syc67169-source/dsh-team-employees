// 读 DSH 自己的本地账本，把「花了多少钱」变成可读数字。
//
// 说明：这是宿主写的文件，不是公开契约，版本之间可能变。所以这里全部按
// best-effort 处理——读不到就返回 null，绝不因为它改格式而拖垮整个插件。

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { dshHome } from './store.mjs'

export function usagePath() {
  return process.env.DSH_USAGE_PATH || path.join(dshHome(), '.dshw-usage.json')
}

/** 1e8 个 units = 1 个货币单位（账本用的最小刻度）。 */
export const UNITS_PER_CURRENCY = 1e8

export async function readUsage() {
  try {
    return JSON.parse(await readFile(usagePath(), 'utf8'))
  } catch {
    return null
  }
}

export function currencyOf(usage) {
  const books = usage?.accounting?.books
  const active = usage?.accounting?.active
  const unit = active !== undefined ? books?.[active]?.currency : undefined
  return typeof unit === 'string' && unit.length > 0 ? unit : 'CNY'
}

/** 今日支出。优先用 history（宿主自己算好的），缺了再从账本 days 里推。 */
export function todaySpend(usage, day = new Date()) {
  if (usage === null || usage === undefined) return null
  const key = typeof day === 'string' ? day : new Date(day).toISOString().slice(0, 10)
  const fromHistory = usage?.history?.[key]
  if (Number.isFinite(fromHistory)) return { amount: fromHistory, currency: currencyOf(usage), source: 'history' }
  const active = usage?.accounting?.active
  const debit = usage?.accounting?.books?.[active]?.days?.[key]?.debitUnits
  if (Number.isFinite(debit)) {
    return { amount: Number((debit / UNITS_PER_CURRENCY).toFixed(4)), currency: currencyOf(usage), source: 'ledger' }
  }
  return null
}

/** 账户余额。dayStart - 今日支出 是宿主的算法，这里优先读它给的结果。 */
export function balanceOf(usage) {
  if (usage === null || usage === undefined) return null
  const balance = Number.isFinite(usage?.lastBalance) ? usage.lastBalance : null
  if (balance === null) return null
  return { amount: balance, currency: currencyOf(usage) }
}

/** 逐次调用的公开记录：{ts, day, model, cost, tokens}。 */
export function callEvents(usage) {
  return Array.isArray(usage?.events) ? usage.events : []
}

export function totalTokens(usage) {
  return callEvents(usage).reduce((sum, event) => sum + (Number(event?.tokens) || 0), 0)
}

/**
 * 两次快照之间的支出差额。
 * 同一个进程里前后各读一次，就能把「这一次工具调用烧了多少」从账本里减出来。
 * 跨进程的算法调用不一定落在同一个文件上，所以这里只当估算，别当审计。
 */
export function spendDelta(before, after) {
  if (after === null || after === undefined) return { cny: 0, tokens: 0, measured: false }
  const day = new Date().toISOString().slice(0, 10)
  const afterSpend = todaySpend(after, day)?.amount ?? null
  const beforeSpend = before === null || before === undefined ? null : todaySpend(before, day)?.amount ?? null
  const afterTokens = totalTokens(after)
  const beforeTokens = before === null || before === undefined ? 0 : totalTokens(before)
  if (afterSpend === null) return { cny: 0, tokens: 0, measured: false }
  const cny = beforeSpend === null ? 0 : Number(Math.max(0, afterSpend - beforeSpend).toFixed(6))
  return {
    cny,
    tokens: Math.max(0, afterTokens - beforeTokens),
    currency: currencyOf(after),
    measured: beforeSpend !== null
  }
}

export function formatUsage(usage, day = new Date()) {
  if (usage === null || usage === undefined) {
    return `读不到本地账本（${usagePath()}）。成本一栏会保持 0，不影响流水线本身。`
  }
  const today = todaySpend(usage, day)
  const balance = balanceOf(usage)
  const lines = [
    `本地账本：${usagePath()}`,
    today === null ? '今日支出：账本里没有今天的记录' : `今日支出：${today.amount} ${today.currency}（来源：${today.source}）`,
    balance === null ? '余额：未记录' : `余额：${balance.amount} ${balance.currency}`
  ]
  const events = callEvents(usage)
  if (events.length > 0) {
    const recent = events.slice(-5)
    lines.push(`最近 ${recent.length} 次调用：`)
    for (const event of recent) {
      lines.push(`  ${event.day ?? '?'}｜${event.model ?? '?'}｜${Number(event.cost ?? 0).toFixed(4)}｜${event.tokens ?? 0} tokens`)
    }
  }
  return lines.join('\n')
}
