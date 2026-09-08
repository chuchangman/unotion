/**
 * MCP 용 개인 액세스 토큰.
 *
 * 평문은 발급 시 딱 한 번만 보여주고 DB 에는 SHA-256 해시만 남긴다.
 * 토큰은 사용자 한 명을 가리킬 뿐이고, 권한은 여전히 permissions.ts 가 정한다.
 * 즉 MCP 로 들어와도 웹 UI 와 완전히 같은 권한 경계를 지난다.
 */
import 'server-only'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from './db'
import { accessTokens, profiles } from './schema'
import { Unauthorized } from './errors'
import * as audit from './audit'
import type { Actor } from './actor'

const PREFIX = 'unot_'
const BYTES = 24 // 48 hex chars

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex')

export type IssuedToken = {
  id: string
  name: string
  /** 이 값은 여기서만 존재한다. 저장되지 않는다. */
  plaintext: string
}

export async function issueToken(actor: Actor, name: string): Promise<IssuedToken> {
  const plaintext = PREFIX + randomBytes(BYTES).toString('hex')
  const [row] = await db.insert(accessTokens).values({
    userId: actor.userId,
    name: name.trim() || 'MCP',
    tokenHash: hash(plaintext),
  }).returning({ id: accessTokens.id, name: accessTokens.name })

  await audit.record(actor, 'token.issue', { targetId: row.id, meta: { name: row.name } })
  return { ...row, plaintext }
}

export async function listTokens(actor: Actor) {
  return db
    .select({
      id: accessTokens.id,
      name: accessTokens.name,
      lastUsedAt: accessTokens.lastUsedAt,
      createdAt: accessTokens.createdAt,
    })
    .from(accessTokens)
    .where(and(eq(accessTokens.userId, actor.userId), isNull(accessTokens.revokedAt)))
    .orderBy(desc(accessTokens.createdAt))
}

export async function revokeToken(actor: Actor, id: string) {
  await db.update(accessTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(accessTokens.id, id), eq(accessTokens.userId, actor.userId)))
  await audit.record(actor, 'token.revoke', { targetId: id })
}

/**
 * Authorization 헤더 -> userId.
 *
 * 해시 비교는 상수시간으로 한다. 해시끼리 비교하므로 길이는 항상 같다.
 */
export async function resolveBearer(header: string | null): Promise<{
  userId: string
  displayName: string
  tokenId: string
}> {
  const raw = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!raw || !raw.startsWith(PREFIX)) {
    throw new Unauthorized('Bearer 토큰이 없습니다. 앱의 설정 > 액세스 토큰에서 발급하세요.')
  }

  const digest = hash(raw)
  const [row] = await db
    .select({
      id: accessTokens.id,
      userId: accessTokens.userId,
      tokenHash: accessTokens.tokenHash,
      revokedAt: accessTokens.revokedAt,
      displayName: profiles.displayName,
    })
    .from(accessTokens)
    .innerJoin(profiles, eq(profiles.id, accessTokens.userId))
    .where(eq(accessTokens.tokenHash, digest))
    .limit(1)

  if (!row || row.revokedAt) throw new Unauthorized('토큰이 유효하지 않거나 폐기되었습니다.')

  // 조회 자체가 해시 동등성으로 이뤄지지만, 방어적으로 한 번 더 상수시간 비교한다
  const a = Buffer.from(digest, 'hex')
  const b = Buffer.from(row.tokenHash, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Unauthorized('토큰이 유효하지 않습니다.')
  }

  // 마지막 사용 시각은 실패해도 요청을 막지 않는다
  void db.update(accessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(accessTokens.id, row.id))
    .catch(() => {})

  return { userId: row.userId, displayName: row.displayName, tokenId: row.id }
}
