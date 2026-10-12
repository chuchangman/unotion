'use server'

/**
 * 페이지 공유 웹 어댑터. 로직은 없다 — lib/core/sharing 을 부르고 직렬화만 한다.
 *
 * revalidatePath 를 부른다. 권한을 바꾸면 사이드바 트리와 페이지 접근이 달라지는데,
 * 바꾼 사람 본인의 화면도 다시 그려야 "지금 이 페이지를 계속 볼 수 있나"가 맞게 나온다.
 */
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/auth'
import * as Sharing from '@/lib/core/sharing'
import * as PublicShares from '@/lib/core/public-share'
import { PERMISSION_LEVELS } from '@/lib/core/schema'
import type { PermissionLevel } from '@/lib/core/schema'
import type { SharingEntry } from '@/lib/core/sharing'
import type { PublicShare } from '@/lib/core/public-share'
import { run, type ActionResult } from '@/lib/action'
import { Id, parse } from '@/lib/validation'

export async function getPageSharing(
  pageId: string,
): Promise<ActionResult<{ entries: SharingEntry[]; canManage: boolean }>> {
  return run('sharing', async () => {
    const id = parse(Id, pageId)
    const actor = await requireActor()
    return Sharing.getPageSharing(actor, id)
  })
}

export async function setPagePermission(
  pageId: string,
  userId: string,
  level: PermissionLevel,
): Promise<ActionResult<null>> {
  return run('sharing', async () => {
    const id = parse(Id, pageId)
    const user = parse(Id, userId)
    const valid = parse(z.enum(PERMISSION_LEVELS, '알 수 없는 권한 등급입니다'), level)
    const actor = await requireActor()
    await Sharing.setPagePermission(actor, id, user, valid)
    revalidatePath('/', 'layout')
    return null
  })
}

export async function clearPagePermission(
  pageId: string,
  userId: string,
): Promise<ActionResult<null>> {
  return run('sharing', async () => {
    const id = parse(Id, pageId)
    const user = parse(Id, userId)
    const actor = await requireActor()
    await Sharing.clearPagePermission(actor, id, user)
    revalidatePath('/', 'layout')
    return null
  })
}

// ─────────────────────────────────── 웹 공개 공유

export async function getPublicShare(
  pageId: string,
): Promise<ActionResult<PublicShare | null>> {
  return run('sharing', async () => {
    const id = parse(Id, pageId)
    const actor = await requireActor()
    return PublicShares.getPublicShare(actor, id)
  })
}

export async function createPublicShare(
  pageId: string,
  allowIndexing = false,
): Promise<ActionResult<PublicShare>> {
  return run('sharing', async () => {
    const id = parse(Id, pageId)
    const actor = await requireActor()
    return PublicShares.createPublicShare(actor, id, { allowIndexing: parse(z.boolean(), allowIndexing) })
  })
}

export async function revokePublicShare(pageId: string): Promise<ActionResult<null>> {
  return run('sharing', async () => {
    const id = parse(Id, pageId)
    const actor = await requireActor()
    await PublicShares.revokePublicShare(actor, id)
    return null
  })
}
