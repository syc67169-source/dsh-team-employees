import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0))
  }
  // Global-unicast only; refuse mapped IPv4, local, multicast and documentation ranges.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:db8|0|2|10|20):/i.test(address)
}
export async function resolvePublic(url, lookup = dnsLookup, { signal, timeoutMs = 20000 } = {}) {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let records
  if (isIP(host)) records = [{ address: host, family: isIP(host) }]
  else {
    let timer, abort
    try {
      records = await new Promise((resolve, reject) => {
        abort = () => reject(new Error('来源解析已取消'))
        timer = setTimeout(() => reject(new Error('来源 DNS 解析超时')), timeoutMs)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        Promise.resolve().then(() => lookup(host, { all: true })).then(resolve, reject)
      })
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }
  if (!records.length || records.some(row => !publicAddress(row.address))) throw new Error('来源解析到本地/私有地址，已拒绝')
  return records[0]
}
function decodeEntities(text) {
  return text.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, raw) => {
    const value = raw[0].toLowerCase() === 'x' ? parseInt(raw.slice(1), 16) : Number(raw)
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ' '
  }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[name]))
}
export function visibleText(body, contentType = '') {
  if (/json/i.test(contentType)) { JSON.parse(body); return body.trim() }
  return decodeEntities(body.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<!--([\s\S]*?)-->/g, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}
// Transport helper requires an already validated address. User input enters collectSource.
export async function requestSourcePage(url, address, { signal, timeoutMs = 20000, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks = []
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal, agent: false, headers: { 'user-agent': 'dsh-team-research/0.5 (+read-only source monitor)', 'accept': 'text/html, text/plain, application/json, application/rss+xml, application/atom+xml', 'accept-encoding': 'identity' },
      // Pin the validated DNS answer; no check-to-connect DNS rebinding window.
      lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family)
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) { response.resume(); resolve({ redirect: response.headers.location }); return }
      if (response.statusCode < 200 || response.statusCode >= 300) { response.resume(); reject(new Error(`来源返回 HTTP ${response.statusCode}`)); return }
      const type = String(response.headers['content-type'] ?? '')
      if (!/text\/|json|xml/i.test(type) || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        response.resume(); reject(new Error('来源不是支持的未压缩文本/JSON/XML')); return
      }
      response.on('data', chunk => {
        total += chunk.length
        if (total > maxBytes) {
          const error = new Error('来源超过 1 MiB 上限')
          reject(error)
          request.destroy(error)
        }
        else chunks.push(chunk)
      })
      response.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), type }))
      response.on('error', reject)
    })
    const timer = setTimeout(() => { const error = new Error('来源请求超时'); reject(error); request.destroy(error) }, timeoutMs)
    request.on('error', reject)
    request.on('close', () => clearTimeout(timer))
  })
}
export async function collectSource(raw, options = {}) {
  let url = new URL(raw)
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port)) throw new Error('来源或跳转地址不允许')
    const address = await resolvePublic(url, options.lookup, options)
    const page = await requestSourcePage(url, address, options)
    if (page.redirect) { url = new URL(page.redirect, url); continue }
    const text = visibleText(page.body, page.type)
    if (text.length < 20) throw new Error('来源没有足够可读文本；可能需要登录或 JavaScript')
    return { url: raw, finalUrl: url.href, fetchedAt: new Date().toISOString(), hash: createHash('sha256').update(text).digest('hex'), text: text.slice(0, 8000), truncated: text.length > 8000 }
  }
  throw new Error('来源跳转超过 4 次')
}
export function compareSources(previous, current) {
  const old = new Map((previous ?? []).map(row => [row.url, row.hash]))
  return current.filter(row => old.has(row.url) && old.get(row.url) !== row.hash).map(row => row.url)
}
