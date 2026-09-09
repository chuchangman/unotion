'use server'

/**
 * 페이지 공유 웹 어댑터. 로직은 없다 — lib/core/sharing 을 부르고 직렬화만 한다.
 *
 * revalidatePath 를 부른다. 권한을 바꾸면 사이드바 트리와 페이지 접근이 달라지는데,
 * 바꾼 사람 본인의 화면도 다시 그려야 "지금 이 페이지를 계속 볼 수 있나"가 맞게 나온다.
 */
import { revalidatePath } from 'next/cache'
import { requireActor } from '@/lib/auth'
import * as Sharing from '@/lib/core/sharing'
import * as PublicShares from '@/lib/core/public-share'
import { DomainError } from '@/lib/core/errors'
import type { PermissionLevel } from '@/lib/core/schema'
import type { SharingEntry } from '@/lib/core/sharing'
import type { PublicShare } from '@/lib/core/public-share'

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string }

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    if (err instanceof DomainError) {
      return { ok: false, code: err.code, message: err.message }
    }
    console.error('[action:sharing] 예상치 못한 오류', err)
    return { ok: false, code: 'internal', message: '알 수 없는 오류가 발생했습니다' }
  }
}

export async function getPageSharing(
  pageId: string,
): Promise<ActionResult<{ entries: SharingEntry[]; canManage: boolean }>> {
  return run(async () => {
    const actor = await requireActor()
    return Sharing.getPageSharing(actor, pageId)
  })
}

export async function setPagePermission(
  pageId: string,
  userId: string,
  level: PermissionLevel,
): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Sharing.setPagePermission(actor, pageId, userId, level)
    revalidatePath('/', 'layout')
    return null
  })
}

export async function clearPagePermission(
  pageId: string,
  userId: string,
): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Sharing.clearPagePermission(actor, pageId, userId)
    revalidatePath('/', 'layout')
    return null
  })
}

// ─────────────────────────────────── 웹 공개 공유

export async function getPublicShare(
  pageId: string,
): Promise<ActionResult<PublicShare | null>> {
  return run(async () => {
    const actor = await requireActor()
    return PublicShares.getPublicShare(actor, pageId)
  })
}

export async function createPublicShare(
  pageId: string,
  allowIndexing = false,
): Promise<ActionResult<PublicShare>> {
  return run(async () => {
    const actor = await requireActor()
    return PublicShares.createPublicShare(actor, pageId, { allowIndexing })
  })
}

export async function revokePublicShare(pageId: string): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await PublicShares.revokePublicShare(actor, pageId)
    return null
  })
}
