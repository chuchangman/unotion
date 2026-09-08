import { type NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

/**
 * Next 16 부터 middleware -> proxy 로 파일/함수명이 바뀌었다.
 * 세션 쿠키 갱신 + 미인증 접근 차단.
 * Supabase 세션은 여기서만 갱신된다 (서버 컴포넌트는 쿠키를 못 쓴다).
 */
export async function proxy(request: NextRequest) {
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

  const { data: { user } } = await supabase.auth.getUser()

  const isPublic =
    request.nextUrl.pathname.startsWith('/login') ||
    request.nextUrl.pathname.startsWith('/auth') ||
    request.nextUrl.pathname.startsWith('/share')

  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', request.nextUrl.pathname)
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
