/**
 * 팀 초대.
 *
 * 메일 발송은 여기서 하지 않는다 (lib/core 는 HTTP/Supabase 를 모른다).
 * 토큰만 만들어 주고, 발송은 app/actions/invites.ts 가 담당한다.
 */
import 'server-only'
import { randomBytes } from 'node:crypto'
import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm'
import { db } from './db'
import { invites, profiles, workspaceMembers } from './schema'
import { Forbidden, InvalidInput, NotFound } from './errors'
import { assertWorkspaceMember } from './permissions'
import * as audit from './audit'
import type { Actor } from './actor'

const VALID_DAYS = 14
export type InviteRole = 'admin' | 'member' | 'guest'

/** owner/admin 만 초대할 수 있다 */
async function assertCanInvite(actor: Actor, workspaceId: string) {
  const role = await assertWorkspaceMember(actor.userId, workspaceId)
  if (role !== 'owner' && role !== 'admin') {
    throw new Forbidden('초대는 관리자만 할 수 있습니다')
  }
  return role
}

export async function createInvite(
  actor: Actor,
  input: { workspaceId: string; email: string; role?: InviteRole },
) {
  await assertCanInvite(actor, input.workspaceId)

  const email = input.email.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new InvalidInput('이메일 형식이 올바르지 않습니다')
  }

  // 이미 멤버인지 확인
  const [existing] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, profiles.id))
    .where(and(eq(profiles.email, email), eq(workspaceMembers.workspaceId, input.workspaceId)))
    .limit(1)
  if (existing) throw new InvalidInput('이미 이 워크스페이스의 멤버입니다')

  const token = randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + VALID_DAYS * 86_400_000)

  const [row] = await db.insert(invites).values({
    workspaceId: input.workspaceId,
    email,
    role: input.role ?? 'member',
    token,
    invitedBy: actor.userId,
    expiresAt,
  }).returning({ id: invites.id, token: invites.token, email: invites.email })

  await audit.record(actor, 'invite.create', {
    workspaceId: input.workspaceId, targetId: row.id, meta: { email, role: input.role ?? 'member' },
  })
  return row
}

export async function listInvites(actor: Actor, workspaceId: string) {
  await assertCanInvite(actor, workspaceId)
  return db
    .select({
      id: invites.id,
      email: invites.email,
      role: invites.role,
      expiresAt: invites.expiresAt,
    })
    .from(invites)
    .where(and(eq(invites.workspaceId, workspaceId), isNull(invites.acceptedAt)))
    .orderBy(desc(invites.expiresAt))
}

export async function revokeInvite(actor: Actor, inviteId: string) {
  const [row] = await db.select().from(invites).where(eq(invites.id, inviteId)).limit(1)
  if (!row) throw new NotFound('Invite')
  await assertCanInvite(actor, row.workspaceId)
  await db.delete(invites).where(eq(invites.id, inviteId))
  await audit.record(actor, 'invite.revoke', {
    workspaceId: row.workspaceId, targetId: inviteId, meta: { email: row.email },
  })
}

/**
 * 이메일로 대기 중인 초대를 찾는다.
 *
 * Google 로그인을 쓰면 사람들은 초대 링크를 누르지 않고 그냥 로그인해버린다.
 * 그래서 로그인 시점에 이걸로 초대를 자동 수락한다.
 */
export async function findPendingInviteByEmail(email: string) {
  const [row] = await db
    .select({
      id: invites.id,
      workspaceId: invites.workspaceId,
      role: invites.role,
      email: invites.email,
    })
    .from(invites)
    .where(and(
      eq(invites.email, email.trim().toLowerCase()),
      isNull(invites.acceptedAt),
      gt(invites.expiresAt, new Date()),
    ))
    .orderBy(asc(invites.expiresAt))
    .limit(1)
  return row ?? null
}

/** 로그인 시 자동 수락. 이미 멤버면 조용히 넘어간다. */
export async function autoAcceptInvite(
  actor: Actor,
  email: string,
): Promise<{ workspaceId: string } | null> {
  const invite = await findPendingInviteByEmail(email)
  if (!invite) return null

  await db.transaction(async (tx) => {
    await tx.insert(workspaceMembers)
      .values({ workspaceId: invite.workspaceId, userId: actor.userId, role: invite.role })
      .onConflictDoNothing()
    await tx.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id))
  })

  await audit.record(actor, 'invite.auto_accept', {
    workspaceId: invite.workspaceId, targetId: invite.id, meta: { email },
  })
  return { workspaceId: invite.workspaceId }
}

/** 초대 정보 조회 (수락 화면에서 무엇에 초대됐는지 보여주기 위함) */
export async function peekInvite(token: string) {
  const [row] = await db
    .select({
      id: invites.id,
      email: invites.email,
      role: invites.role,
      workspaceId: invites.workspaceId,
      expiresAt: invites.expiresAt,
      acceptedAt: invites.acceptedAt,
    })
    .from(invites)
    .where(eq(invites.token, token))
    .limit(1)
  return row ?? null
}

/**
 * 초대 수락. 로그인한 사용자를 멤버로 추가한다.
 *
 * 이메일 일치를 요구한다 — 링크가 유출돼도 다른 계정으로는 못 들어온다.
 */
export async function acceptInvite(
  actor: Actor,
  token: string,
): Promise<{ workspaceId: string }> {
  const invite = await peekInvite(token)
  if (!invite) throw new NotFound('Invite')
  if (invite.acceptedAt) throw new InvalidInput('이미 사용된 초대입니다')
  if (invite.expiresAt < new Date()) throw new InvalidInput('만료된 초대입니다')

  const [me] = await db
    .select({ email: profiles.email })
    .from(profiles)
    .where(eq(profiles.id, actor.userId))
    .limit(1)
  if (!me) throw new NotFound('Profile')
  if (me.email.toLowerCase() !== invite.email.toLowerCase()) {
    throw new Forbidden(
      `이 초대는 ${invite.email} 로 발송되었습니다. 해당 계정으로 로그인해 주세요.`,
    )
  }

  await db.transaction(async (tx) => {
    await tx.insert(workspaceMembers)
      .values({ workspaceId: invite.workspaceId, userId: actor.userId, role: invite.role })
      .onConflictDoNothing()
    await tx.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id))
  })

  await audit.record(actor, 'invite.accept', {
    workspaceId: invite.workspaceId, targetId: invite.id, meta: { email: invite.email },
  })
  return { workspaceId: invite.workspaceId }
}
