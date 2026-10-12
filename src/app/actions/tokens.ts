'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/auth'
import * as Tokens from '@/lib/core/tokens'
import { run, type ActionResult } from '@/lib/action'
import { Id, parse } from '@/lib/validation'

/** 평문 토큰은 이 응답에만 존재한다. 다시 볼 수 없다. */
export async function issueToken(name: string): Promise<ActionResult<{ plaintext: string }>> {
  return run('tokens', async () => {
    const valid = parse(z.string().max(100, '이름이 너무 깁니다'), name)
    const actor = await requireActor()
    const t = await Tokens.issueToken(actor, valid)
    revalidatePath('/settings/tokens')
    return { plaintext: t.plaintext }
  })
}

export async function revokeToken(id: string): Promise<ActionResult<null>> {
  return run('tokens', async () => {
    const valid = parse(Id, id)
    const actor = await requireActor()
    await Tokens.revokeToken(actor, valid)
    revalidatePath('/settings/tokens')
    return null
  })
}
