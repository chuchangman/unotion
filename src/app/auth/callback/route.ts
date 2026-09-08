import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { bootstrapAfterLogin } from '@/lib/auth'
import { getFirstPageId } from '@/lib/core/workspaces'

/** 매직링크 / OAuth 콜백. 코드를 세션으로 교환하고 프로필을 만든다. */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`)
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`)
  }

  // 세션 교환은 됐는데 DB 가 안 붙으면 여기서 터진다.
  // raw 500 은 화면에 아무것도 안 보여줘서 원인 파악이 불가능하다 — 메시지로 바꾼다.
  let destination = next
  try {
    const session = await bootstrapAfterLogin()

    // next 가 기본값이면 "/" 를 거치지 않고 첫 페이지로 바로 보낸다.
    // "/" 는 사이드바 레이아웃(트리 조회)까지 렌더한 뒤 리다이렉트하므로
    // 로그인 직후 체감되는 왕복이 하나 더 붙는다.
    if (!session?.workspace) {
      // 초대받지 못한 사용자 — 대기 화면으로
      destination = '/pending'
    } else if (next === '/') {
      const firstPage = await getFirstPageId(session.workspace.id)
      if (firstPage) destination = `/p/${firstPage}`
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error('[auth/callback] bootstrapAfterLogin 실패', err)
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent('로그인은 됐지만 DB 연결에 실패했습니다: ' + detail)}`,
    )
  }

  return NextResponse.redirect(`${origin}${destination}`)
}
