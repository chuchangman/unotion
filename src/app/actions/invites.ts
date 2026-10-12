'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireActor, requireSessionContext } from '@/lib/auth'
import * as Invites from '@/lib/core/invites'
import { run, type ActionResult } from '@/lib/action'
import { Id, parse } from '@/lib/validation'

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
): Promise<ActionResult<{ inviteUrl: string; emailed: boolean }>> {
  return run('invites', async () => {
    // 이메일 형식은 core 가 본다 (invites.ts 의 createInvite)
    const address = parse(z.string().max(320, '이메일이 너무 깁니다'), email)
    const validRole = parse(z.enum(['admin', 'member', 'guest']), role)
    const { actor, workspace } = await requireSessionContext()
    const invite = await Invites.createInvite(actor, {
      workspaceId: workspace.id,
      email: address,
      role: validRole,
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

export async function revokeInvite(inviteId: string): Promise<ActionResult<null>> {
  return run('invites', async () => {
    const id = parse(Id, inviteId)
    const actor = await requireActor()
    await Invites.revokeInvite(actor, id)
    revalidatePath('/settings/members')
    return null
  })
}

export async function acceptInvite(token: string): Promise<ActionResult<null>> {
  return run('invites', async () => {
    const valid = parse(z.string().min(1).max(200), token)
    const actor = await requireActor()
    await Invites.acceptInvite(actor, valid)
    revalidatePath('/', 'layout')
    return null
  })
}
