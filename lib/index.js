/**
 * dsh-quote —— DSH bundle 插件（宿主侧）
 *
 * 职责：
 *   1. 把 lib/quote.js 作为 /dsh-quote/quote.js 提供出去（每次请求现读，便于迭代）
 *   2. 往页面 HTML 的 </body> 前注入 <script defer> 标签
 *   3. 提供 POST /dsh-quote/store —— 客户端把引用原文存在这里，
 *      返回一个短 id；消息里只出现 "❝id"，原文不进对话。
 *
 * 引用原文落盘在 $DSH_HOME/.dsh-quote-store.json，
 * 所以宿主重启也不会丢（除非手动删文件）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const name = 'dsh-quote'
const inject = ['webServer']

const QUOTE_PATH = new URL('./quote.js', import.meta.url)
const ROUTE = '/dsh-quote/quote.js'
const STORE_ROUTE = '/dsh-quote/store'

/** 引用仓库路径：跟随 DSH_HOME，缺省 ~/.dsh */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STORE_PATH = join(DSH_HOME, '.dsh-quote-store.json')

/** 最多保留多少条引用（超出丢最旧的） */
const MAX_QUOTES = 300
/** 单条引用最大字节数（防滥用） */
const MAX_BODY = 256 * 1024

/** 每次请求都重新读文件 —— 改 quote.js 后只需刷新浏览器，不必重启。 */
function loadQuoteJs() {
  try {
    return readFileSync(QUOTE_PATH, 'utf8')
  } catch (err) {
    return '/* dsh-quote: quote.js 读取失败: ' + String(err && err.message) + ' */'
  }
}

function loadStore() {
  try {
    const raw = readFileSync(STORE_PATH, 'utf8')
    const s = JSON.parse(raw)
    if (!s || typeof s !== 'object') throw new Error('bad shape')
    if (typeof s.next !== 'number') s.next = 1
    if (!s.quotes || typeof s.quotes !== 'object') s.quotes = {}
    return s
  } catch (err) {
    return { next: 1, quotes: {} }
  }
}

function saveStore(store) {
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true })
    writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8')
    return true
  } catch (err) {
    return false
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { try { req.destroy() } catch (e) {} return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

function apply(ctx) {
  const disposers = []

  // 1) 客户端脚本（每次请求现读）
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: (req, res) => {
      const body = loadQuoteJs()
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
      })
      res.end(body)
    },
  }))

  // 2) 引用仓库写入接口
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: STORE_ROUTE,
    handler: (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'POST only' }))
        return
      }
      readBody(req).then((body) => {
        const text = String(body || '')
        if (!text.trim()) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'empty' }))
          return
        }
        const store = loadStore()
        const id = String(store.next++)
        store.quotes[id] = { text, ts: Date.now() }

        // 超量裁剪
        const keys = Object.keys(store.quotes)
        if (keys.length > MAX_QUOTES) {
          for (const k of keys.slice(0, keys.length - MAX_QUOTES)) delete store.quotes[k]
        }

        const saved = saveStore(store)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, id, saved, chars: text.length }))
      }).catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'read failed' }))
      })
    },
  }))

  // 3) 引用读取接口： GET /dsh-quote/get/<id>
  disposers.push(ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-quote/get',
    handler: (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      const url = String(req.url || '')
      const m = url.match(/\/dsh-quote\/get\/([0-9]+)/)
      const id = m ? m[1] : ''
      const store = loadStore()
      const item = id ? store.quotes[id] : undefined
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      if (item) {
        res.end(JSON.stringify({ ok: true, id, text: item.text, ts: item.ts }))
      } else {
        res.end(JSON.stringify({ ok: false, id, error: 'not found' }))
      }
    },
  }))

  // 4) 注入 <script> 标签
  disposers.push(ctx.webServer.tapIndex((html) => {
    if (html.indexOf(ROUTE) !== -1) return html
    const tag = '<script defer src="' + ROUTE + '"></script>'
    if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
    return html + tag
  }))

  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch (err) { /* 释放失败不阻断 */ }
    }
  })
}

export { name, inject, apply }
