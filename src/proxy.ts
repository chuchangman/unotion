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
    // login/share 는 함수 호출 자체를 아끼려고 matcher 에서 뺀다.
    // (본문에서 어차피 즉시 통과시키지만, 그래도 람다가 한 번 뜬다 —
    //  실측 CDN 69ms vs proxy 통과 158ms)
    // mcp 는 Bearer 토큰으로 자체 인증하므로 쿠키 미들웨어가 필요 없다.
    //
    // ★ api/transcribe 도 뺀다 — 여기의 미인증 처리가 **리다이렉트**이기 때문이다.
    //   fetch 는 307 을 자동으로 따라가서 로그인 HTML 을 200 으로 받고, 호출부는
    //   `res.ok` 가 true 니까 성공으로 알고 `res.json()` 에서 터진다. 회의 받아쓰기는
    //   백그라운드로 도는 호출이라 그 예외가 아무 데도 안 보이고 받아쓰기만 조용히 멎는다.
    //   (액세스 토큰은 기본 1시간에 만료되므로 긴 회의에서 실제로 닿는 경로다.)
    //
    //   대신 라우트가 getActor() 로 직접 인증하고 401 JSON 을 돌려준다. 세션 갱신도
    //   그대로 된다 — 라우트 핸들러는 서버 컴포넌트와 달리 쿠키를 쓸 수 있어서
    //   lib/supabase/server.ts 의 setAll 이 실제로 동작한다.
    '/((?!_next/static|_next/image|favicon.ico|login|share|mcp|api/mcp|api/transcribe|.*\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
