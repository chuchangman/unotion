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
    path.startsWith('/share')

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

  /**
   * 보호 경로에서는 이 호출이 세션 토큰 갱신도 겸한다 (만료됐으면 refresh 토큰으로 새로 받아
   * 위의 setAll 로 쿠키에 쓴다). 여기서 생략하면 액세스 토큰 만료(기본 1시간)마다 로그아웃된다.
   *
   * ★ getUser() 가 아니라 getClaims() — 매 요청 Auth 서버로 나가던 왕복을 없앤다.
   *   프로젝트가 비대칭 서명 키(JWKS)를 쓰면 JWT 서명을 **여기서** 검증한다. 공개키는 람다
   *   안에 캐시된다(auth-js 의 GLOBAL_JWKS). 대칭 키(HS256) 프로젝트면 auth-js 가 알아서
   *   getUser() 로 떨어지므로 지금과 같다 — Supabase 대시보드에서 키를 옮겨야 효과가 난다.
   *   대가: 로그아웃한 세션의 액세스 토큰도 만료 전까지는 서명상 유효하다. 권한은 매 요청
   *   DB 멤버십으로 다시 보므로(lib/core/permissions.ts) 내보낸 사람이 계속 들어오지는 못한다.
   */
  const { data } = await supabase.auth.getClaims()

  if (!data?.claims) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', path)
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  matcher: [
    // login/share 는 함수 호출 자체를 아끼려고 matcher 에서 뺀다.
    // (본문에서 어차피 즉시 통과시키지만, 그래도 람다가 한 번 뜬다 —
    //  실측 CDN 69ms vs proxy 통과 158ms)
    //
    // ★ api/ 는 통째로 뺀다 — 여기의 미인증 처리가 **리다이렉트**이기 때문이다.
    //   fetch 는 307 을 자동으로 따라가서 로그인 HTML 을 200 으로 받고, 호출부는
    //   `res.ok` 가 true 니까 성공으로 알고 `res.json()` 에서 터진다. 회의 받아쓰기가
    //   실제로 그렇게 조용히 멎었다 (액세스 토큰은 기본 1시간에 만료된다).
    //
    //   대신 라우트가 스스로 인증한다 — mcp 는 Bearer 토큰, 나머지는 lib/api/route.ts 의
    //   withActor 가 401 JSON 을 돌려준다. 세션 갱신도 그대로 된다 — 라우트 핸들러는
    //   서버 컴포넌트와 달리 쿠키를 쓸 수 있어서 lib/supabase/server.ts 의 setAll 이
    //   실제로 동작한다. 덤으로 API 호출마다 proxy 의 인증 왕복이 한 번씩 빠진다.
    //
    // manifest.webmanifest 도 뺀다 — 브라우저가 쿠키 없이 가져가서 리다이렉트를 먹으면
    // 홈 화면 설치가 안 된다 (app/manifest.ts)
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|login|share|mcp|api/|.*\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
