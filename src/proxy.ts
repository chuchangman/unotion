import { type NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

/**
 * Next 16 부터 middleware -> proxy 로 파일/함수명이 바뀌었다.
 * 세션 쿠키 갱신 + 미인증 접근 차단.
 * Supabase 세션은 여기서만 갱신된다 (서버 컴포넌트는 쿠키를 못 쓴다).
 */
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname

  /**
   * ★ 공개 경로는 인증 호출 없이 즉시 통과시킨다.
   *
   * 이전에는 getUser() 를 먼저 부르고 나서 공개 여부를 따졌다.
   * getUser() 는 Supabase Auth 로 나가는 네트워크 호출이라,
   * 로그인 화면 자체가 매번 그 왕복을 지불했다 (실측 81ms -> 360ms).
   */
  const isPublic =
    path.startsWith('/login') ||
    path.startsWith('/auth') ||
    path.startsWith('/share') ||
    path === '/api/health'

  if (isPublic) return NextResponse.next({ request })

  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(toSet) {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          toSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options))
        },
      },
    },
  )

  // 보호 경로에서는 getUser() 가 세션 토큰 갱신도 겸한다.
  // 여기서 생략하면 액세스 토큰 만료(기본 1시간)마다 로그아웃된다.
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', path)
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  matcher: [
    // MCP 엔드포인트는 Bearer 토큰으로 자체 인증한다 — 쿠키 미들웨어 제외
    '/((?!_next/static|_next/image|favicon.ico|mcp|api/mcp|.*\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
