'use server'

import { revalidatePath } from 'next/cache'
import { requireActor } from '@/lib/auth'
import * as Tokens from '@/lib/core/tokens'
import { DomainError } from '@/lib/core/errors'

export type Result<T> = { ok: true; data: T } | { ok: false; message: string }

async function run<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    if (err instanceof DomainError) return { ok: false, message: err.message }
    console.error('[action:tokens]', err)
    return { ok: false, message: '알 수 없는 오류가 발생했습니다' }
  }
}

/** 평문 토큰은 이 응답에만 존재한다. 다시 볼 수 없다. */
export async function issueToken(name: string): Promise<Result<{ plaintext: string }>> {
  return run(async () => {
    const actor = await requireActor()
    const t = await Tokens.issueToken(actor, name)
    revalidatePath('/settings/tokens')
    return { plaintext: t.plaintext }
  })
}

export async function revokeToken(id: string): Promise<Result<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Tokens.revokeToken(actor, id)
    revalidatePath('/settings/tokens')
    return null
  })
}
