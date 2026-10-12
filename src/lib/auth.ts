import { cache } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from './supabase/server'
import { ensureProfile, ensureWorkspaceOnLogin, getMyWorkspaces } from './core/workspaces'
import type { MyWorkspace } from './core/workspaces'
import type { WorkspaceRole } from './core/permissions'
import { autoAcceptInvite } from './core/invites'
import { webActor } from './core/actor'
import type { Actor } from './core/actor'

/** 이 요청의 사용자 — JWT 클레임에서 필요한 것만 */
type SessionUser = {
  id: string
  email: string | null
  user_metadata: Record<string, unknown>
}

/**
 * Supabase 세션 -> Actor 로 변환하는 유일한 지점.
 * lib/core 는 Supabase 를 모른다 — 그래서 MCP 어댑터가 같은 core 를 재사용할 수 있다.
 *
 * ★ 성능: getClaims() 로 **JWT 를 여기서 검증**한다.
 *   예전 getUser() 는 Supabase Auth API 를 매번 네트워크로 불렀다 — proxy 에서 한 번, 여기서
 *   또 한 번이라 문서 하나를 열면 네 번(RSC + 본문 요청), 자동저장마다 두 번이었다.
 *   비대칭 서명 키 프로젝트면 공개키(JWKS)로 검증하고 키는 람다 안에 캐시된다. 대칭 키면
 *   auth-js 가 getUser() 로 떨어진다 (proxy.ts 주석 참고).
 *   그래도 한 요청 안에서 레이아웃·페이지·액션이 각자 부르므로 cache() 로 1회로 묶는다.
 */
const currentUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getClaims()
  const claims = data?.claims
  if (error || !claims?.sub) return null
  return {
    id: claims.sub,
    email: claims.email ?? null,
    user_metadata: (claims.user_metadata ?? {}) as Record<string, unknown>,
  }
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

/**
 * 지금 보고 있는 프로젝트 룸을 담는 쿠키. 값은 워크스페이스 id 다.
 *
 * 서버에서만 읽고 쓴다 — 클라이언트가 읽을 일이 없어서 httpOnly 로 둔다.
 * 사용자 선택일 뿐이고 권한의 근거가 아니다. 이 값은 **항상** 내 룸 목록과
 * 대조한 뒤에 쓴다 (아래 getSessionContext 참고).
 */
export const ACTIVE_WORKSPACE_COOKIE = 'ws'

export type SessionContext = {
  actor: Actor
  /** 지금 보고 있는 룸 */
  workspace: { id: string; name: string; role: WorkspaceRole }
  /** 내가 속한 룸 전부 (사이드바 드롭다운용) */
  workspaces: MyWorkspace[]
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

  /**
   * 룸 목록을 한 번만 읽어 활성 룸 선택과 사이드바 드롭다운에 함께 쓴다.
   * 예전에는 기본 룸만 따로 조회했는데, 목록이 어차피 필요해져서 합쳤다 —
   * 왕복 수는 그대로다.
   */
  const list = await getMyWorkspaces(user.id)
  if (list.length === 0) return null

  const store = await cookies()
  const wanted = store.get(ACTIVE_WORKSPACE_COOKIE)?.value

  /**
   * 쿠키 값을 그대로 믿지 않는다. **내 목록에 있는 id 일 때만** 쓴다.
   * 룸에서 빠졌거나 남의 id 가 박힌 쿠키면 조용히 기본 룸으로 떨어진다
   * (목록의 첫 항목이 기본 룸이다 — getMyWorkspaces 의 정렬 주석 참고).
   */
  const active = list.find((w) => w.id === wanted) ?? list[0]

  return {
    actor: webActor(user.id),
    workspace: { id: active.id, name: active.name, role: active.role },
    workspaces: list,
    displayName: nameOf(user),
  }
})

export async function requireSessionContext(): Promise<SessionContext> {
  const user = await currentUser()
  if (!user) redirect('/login')

  const ctx = await getSessionContext()
  // 로그인은 했지만 아직 어떤 워크스페이스에도 속하지 않은 경우.
  // /login 으로 보내면 이미 로그인 상태라 무한 루프가 된다.
  if (!ctx) redirect('/pending')
  return ctx
}

/**
 * 로그인 직후 1회만 호출한다 (/auth/callback).
 * profiles 를 맞추고, 워크스페이스가 없으면 만든다.
 */
export async function bootstrapAfterLogin() {
  /**
   * 여기만 getUser() 다 — Auth 서버에서 **지금** 사용자 정보를 받는다.
   * 로그인 직후 한 번뿐이라 왕복 비용이 문제되지 않고, 프로필 이름·아바타를
   * 토큰에 구워진 옛 값이 아니라 최신 값으로 맞추기 위해서다.
   */
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  await ensureProfile({
    id: user.id,
    email: user.email ?? `${user.id}@unknown.local`,
    displayName: nameOf(user),
    avatarUrl: (user.user_metadata?.avatar_url as string | undefined) ?? null,
  })

  const actor = webActor(user.id)

  /**
   * Google 로그인을 쓰면 사람들은 초대 링크를 안 누르고 그냥 로그인한다.
   * 그래서 여기서 대기 중 초대를 자동 수락한다 — 초대 → 로그인만으로 합류된다.
   */
  const email = user.email ?? ''
  if (email) await autoAcceptInvite(actor, email)

  /**
   * 초대가 없으면 개인 룸을 하나 열어 준다 — 혼자서도 바로 쓸 수 있게.
   *
   * ★ 순서가 중요하다. 위의 autoAcceptInvite 가 **먼저** 돌아야 한다.
   *   초대받은 사람이 여기서 개인 룸부터 받으면 팀 위키 대신 빈 방에 들어가
   *   앉는다. 예전에 실제로 그 사고가 났다 (workspaces.ts 의 ⚠️ 주석).
   */
  const workspace = await ensureWorkspaceOnLogin(actor, nameOf(user))
  return { actor, workspace }
}
