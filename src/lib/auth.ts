import { redirect } from 'next/navigation'
import { createClient } from './supabase/server'
import { ensureProfile, getOrCreateDefaultWorkspace } from './core/workspaces'
import { webActor } from './core/actor'
import type { Actor } from './core/actor'

/**
 * Supabase 세션 -> Actor 로 변환하는 유일한 지점.
 * lib/core 는 Supabase 를 모른다 — 그래서 MCP 어댑터가 같은 core 를 재사용할 수 있다.
 */
export async function getActor(): Promise<Actor | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  return webActor(user.id)
}

export async function requireActor(): Promise<Actor> {
  const actor = await getActor()
  if (!actor) redirect('/login')
  return actor
}

/** 로그인 직후 1회: profiles 동기화 + 기본 워크스페이스 확보 */
export async function bootstrapSession() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  await ensureProfile({
    id: user.id,
    email: user.email ?? `${user.id}@unknown.local`,
    displayName:
      (user.user_metadata?.full_name as string | undefined) ??
      (user.user_metadata?.name as string | undefined) ??
      null,
    avatarUrl: (user.user_metadata?.avatar_url as string | undefined) ?? null,
  })

  const actor = webActor(user.id)
  const workspace = await getOrCreateDefaultWorkspace(actor)
  return { actor, workspace }
}
