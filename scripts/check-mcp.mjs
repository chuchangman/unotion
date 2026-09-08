/**
 * MCP 엔드포인트 왕복 테스트.
 *
 *   npm run check:mcp -- <bearer-token> [base-url]
 *
 * initialize -> tools/list -> tools/call 을 실제 JSON-RPC 로 태운다.
 * 인증 거부(401)도 함께 확인한다.
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

const token = process.argv[2]
const base = process.argv[3] || process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'
if (!token) {
  console.error('\n사용법: npm run check:mcp -- <bearer-token> [base-url]\n')
  process.exit(1)
}
const url = `${base.replace(/\/$/, '')}/api/mcp`
let id = 0

async function rpc(method, params, bearer = token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
  const raw = await res.text()
  // Streamable HTTP 는 SSE 로 감싸 보낼 수 있다
  const line = raw.split('\n').find((l) => l.startsWith('data:'))
  const body = line ? line.slice(5).trim() : raw
  let json = null
  try { json = JSON.parse(body) } catch { /* 비 JSON */ }
  return { status: res.status, json, raw: raw.slice(0, 200) }
}

console.log(`\n대상: ${url}\n`)

// 1) 인증 없이 -> 거부되어야 한다
const anon = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'check-mcp', version: '0' },
}, null)
console.log(`  ${anon.status === 401 ? 'OK  ' : 'FAIL'}  인증 없는 요청 거부 (status ${anon.status})`)

// 2) initialize
const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'check-mcp', version: '0' },
})
const info = init.json?.result?.serverInfo
console.log(`  ${info ? 'OK  ' : 'FAIL'}  initialize  ${info ? `${info.name}@${info.version}` : init.raw}`)
if (!info) process.exit(1)

// 3) tools/list
const tools = await rpc('tools/list', {})
const names = tools.json?.result?.tools?.map((t) => t.name) ?? []
console.log(`  ${names.length ? 'OK  ' : 'FAIL'}  tools/list  ${names.length}개`)
for (const n of names) console.log(`          - ${n}`)

// 4) prompts/list
const prompts = await rpc('prompts/list', {})
const pnames = prompts.json?.result?.prompts?.map((p) => p.name) ?? []
console.log(`  ${pnames.length ? 'OK  ' : 'WARN'}  prompts/list  ${pnames.join(', ') || '없음'}`)

// 5) 읽기 툴 실제 호출
for (const [name, args] of [['list_pages', {}], ['get_recent_changes', { since_hours: 720 }]]) {
  const r = await rpc('tools/call', { name, arguments: args })
  const c = r.json?.result?.content?.[0]?.text
  const err = r.json?.result?.isError
  console.log(`  ${c && !err ? 'OK  ' : 'FAIL'}  ${name}`)
  if (c) console.log(c.split('\n').slice(0, 6).map((l) => '          ' + l).join('\n'))
  if (r.json?.error) console.log('          ' + JSON.stringify(r.json.error))
}
console.log()
