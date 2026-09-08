import { cache } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from './supabase/server'
import { ensureProfile, getOrCreateDefaultWorkspace, getPrimaryWorkspace } from './core/workspaces'
import { webActor } from './core/actor'
import type { Actor } from './core/actor'

/**
 * Supabase 세션 -> Actor 로 변환하는 유일한 지점.
 * lib/core 는 Supabase 를 모른다 — 그래서 MCP 어댑터가 같은 core 를 재사용할 수 있다.
 *
 * ★ 성능: getUser() 는 Supabase Auth API 를 네트워크로 호출한다.
 *   한 요청 안에서 레이아웃·페이지·액션이 각자 부르면 그만큼 왕복이 늘어난다.
 *   React 의 cache() 로 요청 단위 1회로 묶는다.
 */
const currentUser = cache(async () => {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
})

export const getActor = cache(async (): Promise<Actor | null> => {
  const user = await currentUser()
  return user ? webActor(user.id) : null
})

export async function requireActor(): Promise<Actor> {
  const actor = await getActor()
  if (!actor) redirect('/login')
  return actor
}

export type SessionContext = {
  actor: Actor
  workspace: { id: string; name: string }
  displayName: string
}

function nameOf(user: { email?: string | null; user_metadata?: Record<string, unknown> }) {
  const meta = user.user_metadata ?? {}
  return (
    (meta.full_name as string | undefined) ??
    (meta.name as string | undefined) ??
    user.email ??
    '익명'
  )
}

/**
 * 렌더링용 세션 컨텍스트. **읽기만 한다.**
 *
 * 이전 구현은 페이지를 그릴 때마다 profiles UPSERT 를 실행했다.
 * 매 내비게이션에 쓰기 왕복이 하나씩 붙던 셈이라 걷어냈다.
 * 프로필 동기화는 로그인 직후 bootstrapAfterLogin() 에서 한 번만 한다.
 */
export const getSessionContext = cache(async (): Promise<SessionContext | null> => {
  const user = await currentUser()
  if (!user) return null

  const workspace = await getPrimaryWorkspace(user.id)
  if (!workspace) return null

  return { actor: webActor(user.id), workspace, displayName: nameOf(user) }
})

export async function requireSessionContext(): Promise<SessionContext> {
  const ctx = await getSessionContext()
  if (!ctx) redirect('/login')
  return ctx
}

/**
 * 로그인 직후 1회만 호출한다 (/auth/callback).
 * profiles 를 맞추고, 워크스페이스가 없으면 만든다.
 */
export async function bootstrapAfterLogin() {
  const user = await currentUser()
  if (!user) return null

  await ensureProfile({
    id: user.id,
    email: user.email ?? `${user.id}@unknown.local`,
    displayName: nameOf(user),
    avatarUrl: (user.user_metadata?.avatar_url as string | undefined) ?? null,
  })

  const actor = webActor(user.id)
  const workspace = await getOrCreateDefaultWorkspace(actor)
  return { actor, workspace }
}
