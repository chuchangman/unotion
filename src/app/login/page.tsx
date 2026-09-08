'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

/** 매직링크 로그인. OAuth 앱 등록 없이 바로 쓸 수 있다. */
export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [message, setMessage] = useState('')

  // /auth/callback 이 실패하면 ?error= 를 달고 여기로 되돌린다.
  // 이걸 안 보여주면 "링크를 눌렀는데 아무 일도 안 일어남" 으로만 보인다.
  useEffect(() => {
    const err = new URLSearchParams(window.location.search).get('error')
    if (err) {
      setState('error')
      setMessage(err)
    }
  }, [])

  async function signIn(e: React.FormEvent) {
    e.preventDefault()
    setState('sending')

    const supabase = createClient()
    const next = new URLSearchParams(window.location.search).get('next') ?? '/'

    // 프리뷰 배포에서 로그인하면 매직링크가 프리뷰 URL 을 가리키게 된다.
    // NEXT_PUBLIC_SITE_URL 이 있으면 그걸 정본으로 쓴다.
    // ⚠️ 여기서 만드는 주소는 Supabase 의 Redirect URLs 허용목록에 있어야 한다.
    const origin = process.env.NEXT_PUBLIC_SITE_URL || window.location.origin

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo:
          `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    })

    if (error) {
      setState('error')
      setMessage(error.message)
    } else {
      setState('sent')
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-950">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">팀 위키</h1>
        <p className="mb-8 text-sm text-neutral-500">
          이메일로 로그인 링크를 보내드립니다.
        </p>

        {state === 'error' && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {message}
          </div>
        )}

        {state === 'sent' ? (
          <div className="rounded-lg border border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
            <strong className="font-medium">{email}</strong> 로 링크를 보냈습니다.
            <br />
            메일함을 확인해 주세요.
          </div>
        ) : (
          <form onSubmit={signIn} className="space-y-3">
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-100"
            />
            <button
              type="submit"
              disabled={state === 'sending'}
              className="w-full rounded-lg bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {state === 'sending' ? '보내는 중...' : '로그인 링크 받기'}
            </button>
          </form>
        )}
      </div>
    </main>
  )
}
