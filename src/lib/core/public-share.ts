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
 * 공개 페이지에 넣기 전 최소한의 방어.
 *
 * 본문은 우리 에디터가 만든 블록에서 나오므로 원래 스크립트가 들어갈 자리가 없다.
 * 그래도 이건 **로그인 없이 아무나 여는 화면**이라, 붙여넣기나 MCP 로 흘러든
 * 이상한 값이 그대로 실행되지 않도록 한 겹 더 막는다.
 *   - script/iframe/object 등 실행 가능한 태그 제거
 *   - on* 이벤트 속성 제거
 *   - javascript:, data:text/html 스킴 무력화
 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<\s*(script|iframe|object|embed|link|meta|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed|link|meta|style)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*("|')\s*data:text\/html[^"']*\2/gi, '$1="#"')
}
