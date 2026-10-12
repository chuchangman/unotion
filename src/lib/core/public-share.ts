/**
 * 웹 공개 공유.
 *
 * ★ 이 파일에는 **인증 없이 도는 함수가 하나 있다** (resolvePublicPage).
 *   lib/core 의 다른 모든 함수는 Actor 를 받고 assert* 로 시작하지만,
 *   공개 페이지는 로그인하지 않은 사람이 보는 것이 목적이라 그럴 수 없다.
 *   대신 **슬러그를 아는 사람만** 볼 수 있고, 그 슬러그가 유일한 열쇠다. 그래서:
 *     - 슬러그는 추측 불가능해야 한다 (128비트 난수)
 *     - 그 페이지 하나만 돌려준다. 하위 페이지도, 형제도, 워크스페이스 정보도 아니다
 *     - 휴지통에 있으면 없는 것으로 친다
 *
 * 공유를 만들고 없애는 것은 페이지를 관리(full)할 수 있는 사람만 한다.
 */
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from './db'
import { pages, publicShares } from './schema'
import { assertCanManage } from './permissions'
import * as audit from './audit'
import type { Actor } from './actor'

export type PublicShare = {
  pageId: string
  slug: string
  allowIndexing: boolean
  createdAt: Date
}

/** base64url 22자 = 128비트. 목록 API 가 없으므로 이걸 모르면 도달할 수 없다. */
function makeSlug(): string {
  return randomBytes(16).toString('base64url')
}

export async function getPublicShare(
  actor: Actor,
  pageId: string,
): Promise<PublicShare | null> {
  await assertCanManage(actor.userId, pageId)
  const [row] = await db
    .select({
      pageId: publicShares.pageId,
      slug: publicShares.slug,
      allowIndexing: publicShares.allowIndexing,
      createdAt: publicShares.createdAt,
    })
    .from(publicShares)
    .where(eq(publicShares.pageId, pageId))
    .limit(1)
  return row ?? null
}

/**
 * 공개 링크를 만든다. 이미 있으면 그대로 돌려준다 —
 * 다시 누를 때마다 슬러그가 바뀌면 이미 나눠준 링크가 조용히 죽는다.
 */
export async function createPublicShare(
  actor: Actor,
  pageId: string,
  opts: { allowIndexing?: boolean } = {},
): Promise<PublicShare> {
  const access = await assertCanManage(actor.userId, pageId)

  const existing = await getPublicShare(actor, pageId)
  if (existing) return existing

  const [row] = await db.insert(publicShares).values({
    pageId,
    slug: makeSlug(),
    allowIndexing: opts.allowIndexing ?? false,
    createdBy: actor.userId,
  }).returning({
    pageId: publicShares.pageId,
    slug: publicShares.slug,
    allowIndexing: publicShares.allowIndexing,
    createdAt: publicShares.createdAt,
  })

  await audit.record(actor, 'page.publish', {
    workspaceId: access.workspaceId, targetId: pageId, meta: { slug: row.slug },
  })
  return row
}

export async function revokePublicShare(actor: Actor, pageId: string): Promise<void> {
  const access = await assertCanManage(actor.userId, pageId)
  await db.delete(publicShares).where(eq(publicShares.pageId, pageId))
  await audit.record(actor, 'page.unpublish', {
    workspaceId: access.workspaceId, targetId: pageId,
  })
}

export type PublicPage = {
  title: string
  icon: { type: 'emoji' | 'url'; value: string } | null
  html: string
  allowIndexing: boolean
  updatedAt: Date
}

/**
 * 슬러그로 공개 페이지를 읽는다. **인증 없이 불린다.**
 *
 * 돌려주는 것은 렌더에 필요한 최소한이다 — 페이지 id 도, 작성자도, 워크스페이스도
 * 내보내지 않는다. 공개 표면은 좁을수록 좋다.
 */
export async function resolvePublicPage(slug: string): Promise<PublicPage | null> {
  if (!slug || slug.length > 64) return null

  const [row] = await db
    .select({
      title: pages.title,
      icon: pages.icon,
      ydoc: pages.ydoc,
      updatedAt: pages.updatedAt,
      allowIndexing: publicShares.allowIndexing,
    })
    .from(publicShares)
    .innerJoin(pages, eq(pages.id, publicShares.pageId))
    .where(and(eq(publicShares.slug, slug), eq(pages.isTrashed, false)))
    .limit(1)

  if (!row) return null

  const { ydocBytesToHTML } = await import('./markdown')
  const html = sanitizeHtml(await ydocBytesToHTML(row.ydoc))

  return {
    title: row.title,
    icon: row.icon,
    html,
    allowIndexing: row.allowIndexing,
    updatedAt: row.updatedAt,
  }
}

/**
 * 공개 페이지에 넣기 전 마지막 방어.
 *
 * 본문은 우리 에디터가 만든 블록에서 나온다 — 직렬화기가 글자 속 `<` 를 `&lt;` 로
 * 바꾸므로 태그를 끼워 넣을 수는 없다. 뚫리는 곳은 **속성 값**이다. 파일 블록의 URL 에
 * `java\nscript:` 를 넣으면 직렬화기는 그대로 내보내고, 브라우저는 URL 의 줄바꿈을
 * 지운 뒤 스크립트로 연다. 이 화면은 **로그인 없이 아무나 열고, 앱과 출처가 같다.**
 *
 * 그래서 문자열을 여기저기 지우는 대신 태그를 하나씩 읽어 **다시 조립한다.**
 *   - 속성은 이름·값을 따로 읽고 안전한 것만 다시 쓴다. on* 는 버리고,
 *     URL 속성은 브라우저처럼 정규화한 뒤 스킴을 허용 목록으로 본다.
 *   - 태그로 읽히지 않는 `<` 는 `&lt;` 로 바꾼다. 우리가 못 읽은 것을 브라우저가
 *     태그로 읽는 일이 없게 하려는 것이다.
 *   - 글자는 건드리지 않는다. 예전 방식은 본문의 `onClick={go}` 같은 글자까지 지웠다.
 *
 * 입력이 잘 짜인 HTML(직렬화기 출력)이라 정규식이 되돌아갈 일이 없다.
 */
export function sanitizeHtml(html: string): string {
  return html
    // 스크립트·스타일은 내용까지 지운다. 태그만 지우면 코드가 본문 글자로 드러난다
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(TOKEN, (token, endName?: string, name?: string, attrs?: string) => {
      if (endName) return DROPPED_TAGS.has(endName.toLowerCase()) ? '' : `</${endName}>`
      if (name) return DROPPED_TAGS.has(name.toLowerCase()) ? '' : rebuildTag(name, attrs ?? '')
      return token === '<' ? '&lt;' : '' // 주석은 버린다
    })
}

/** 주석 | 닫는 태그 | 여는 태그 | 태그가 못 된 `<`. 따옴표 안의 `>` 는 태그의 끝이 아니다 */
const TOKEN =
  /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)(?:"[^"]*"|'[^']*'|[^'">])*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|</g

/** 이름[=값]. 값은 큰따옴표 | 작은따옴표 | 따옴표 없음 */
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g

/**
 * 여는·닫는 태그를 버리는 요소. 안의 내용은 남아서 다시 걸러진다.
 *   - 실행하거나 다른 문서를 끌어오는 것
 *   - 브라우저가 안을 **글자로** 읽는 것(style, textarea, title …) 과 svg/math.
 *     남겨 두면 우리가 태그로 읽은 곳과 브라우저가 태그로 읽는 곳이 어긋난다.
 */
const DROPPED_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'base', 'link', 'meta', 'form', 'template', 'noscript', 'noembed', 'noframes',
  'textarea', 'title', 'xmp', 'plaintext', 'svg', 'math',
])

/** 값이 URL 로 쓰이는 속성 */
const URL_ATTRS = new Set([
  'href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background', 'data', 'ping', 'cite',
])

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])

function rebuildTag(name: string, attrs: string): string {
  let out = `<${name}`
  for (const [, key, value] of attrs.matchAll(ATTR)) {
    const lower = key.toLowerCase()
    if (lower.startsWith('on') || lower === 'srcdoc') continue
    if (value === undefined) out += ` ${key}`
    else if (URL_ATTRS.has(lower) && !isSafeUrl(unquote(value), lower)) out += ` ${key}="#"`
    else out += ` ${key}=${value}`
  }
  return `${out}>`
}

function unquote(value: string) {
  return value[0] === '"' || value[0] === "'" ? value.slice(1, -1) : value
}

/**
 * 브라우저가 보는 스킴으로 판단한다. 브라우저는 속성 값의 문자 참조를 풀고,
 * URL 에서 탭·줄바꿈을 지우고 앞의 제어 문자·공백을 무시한다.
 * 여기서는 제어 문자·공백을 **전부** 지운다 — 더 많이 막을 뿐 덜 막지는 않는다.
 * 스킴이 없으면(상대 경로) 통과. 이미지 src 만 data:image 를 허용한다.
 */
function isSafeUrl(raw: string, attr: string): boolean {
  const url = decodeCharRefs(raw).replace(/[\x00-\x20\x7f]/g, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1].toLowerCase()
  if (!scheme || SAFE_SCHEMES.has(scheme)) return true
  return attr === 'src' && /^data:image\/(?:png|jpe?g|gif|webp|avif);/i.test(url)
}

/** 스킴을 숨기는 데 쓸 수 있는 참조만 푼다: 숫자 참조와 &Tab; &NewLine; &colon; */
const NAMED_REFS: Record<string, string> = { tab: '\t', newline: '\n', colon: ':', amp: '&' }

function decodeCharRefs(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));?/gi, (ref, hex?: string, dec?: string, named?: string) => {
    if (named) return NAMED_REFS[named.toLowerCase()] ?? ref
    const code = hex ? parseInt(hex, 16) : Number(dec)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�'
  })
}
