import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'

/** 서버 컴포넌트 / 라우트 핸들러용. Next 15+ 에서 cookies() 는 async 다. */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(toSet) {
          try {
            toSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options))
          } catch {
            // 서버 컴포넌트에서는 쿠키를 쓸 수 없다. middleware 가 갱신을 담당한다.
          }
        },
      },
    },
  )
}
