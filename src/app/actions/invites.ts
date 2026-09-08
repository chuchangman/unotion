'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireActor, requireSessionContext } from '@/lib/auth'
import * as Invites from '@/lib/core/invites'
import { DomainError } from '@/lib/core/errors'

export type Result<T> = { ok: true; data: T } | { ok: false; message: string }

async function run<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    if (err instanceof DomainError) return { ok: false, message: err.message }
    console.error('[action:invites]', err)
    return { ok: false, message: '알 수 없는 오류가 발생했습니다' }
  }
}

const siteUrl = () => process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'

/**
 * 초대 생성 + 메일 발송.
 *
 * 메일은 Supabase Auth 의 OTP 발송을 그대로 쓴다. 즉 대시보드에 설정한
 * **커스텀 SMTP(Gmail)로 나간다.** service_role 키가 필요 없다는 게 요점이다 —
 * anon 키로 되는 일에 관리자 키를 끌어들이면 유출 시 피해 범위만 커진다.
 *
 * 대신 메일 문구는 "로그인 링크" 계열이 된다. 링크를 누르면 세션이 만들어지고
 * /invite/<token> 으로 이동해 수락 화면이 뜬다.
 */
export async function inviteMember(
  email: string,
  role: 'admin' | 'member' | 'guest' = 'member',
): Promise<Result<{ inviteUrl: string; emailed: boolean }>> {
  return run(async () => {
    const { actor, workspace } = await requireSessionContext()
    const invite = await Invites.createInvite(actor, {
      workspaceId: workspace.id,
      email,
      role,
    })

    const inviteUrl = `${siteUrl()}/invite/${invite.token}`
    const supabase = await createClient()
    const { error } = await supabase.auth.signInWithOtp({
      email: invite.email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${siteUrl()}/auth/callback?next=${encodeURIComponent(`/invite/${invite.token}`)}`,
      },
    })

    if (error) {
      // 초대 자체는 만들어졌으므로 링크를 직접 전달할 수 있게 돌려준다.
      console.error('[invite] 메일 발송 실패', error.message)
      return { inviteUrl, emailed: false }
    }

    revalidatePath('/settings/members')
    return { inviteUrl, emailed: true }
  })
}

export async function revokeInvite(inviteId: string): Promise<Result<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Invites.revokeInvite(actor, inviteId)
    revalidatePath('/settings/members')
    return null
  })
}

export async function acceptInvite(token: string): Promise<Result<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Invites.acceptInvite(actor, token)
    revalidatePath('/', 'layout')
    return null
  })
}
