'use client'

import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

/**
 * Google 소셜 로그인이 기본이고, 매직링크는 보조 수단으로 남겨둔다.
 * (Google 계정이 없는 외부 게스트를 초대할 때 필요하다.)
 */
export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [showEmail, setShowEmail] = useState(false)

  const nextPath = () =>
    new URLSearchParams(window.location.search).get('next') ?? '/'

  // 프리뷰 배포에서 로그인하면 링크가 프리뷰 URL 을 가리키게 된다.
  // NEXT_PUBLIC_SITE_URL 이 있으면 그걸 정본으로 쓴다.
  const origin = () => process.env.NEXT_PUBLIC_SITE_URL || window.location.origin

  async function signInWithGoogle() {
    setState('sending')
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${origin()}/auth/callback?next=${encodeURIComponent(nextPath())}`,
      },
    })
    if (error) { setState('error'); setMessage(error.message) }
    // 성공 시 브라우저가 Google 로 이동한다
  }

  async function signInWithEmail(e: React.FormEvent) {
    e.preventDefault()
    setState('sending')
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${origin()}/auth/callback?next=${encodeURIComponent(nextPath())}`,
      },
    })
    if (error) { setState('error'); setMessage(error.message) }
    else setState('sent')
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-950">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">팀 위키</h1>
        <p className="mb-8 text-sm text-neutral-500">회사 Google 계정으로 로그인하세요.</p>

        {/*
          /auth/callback 이 실패하면 ?error= 를 달고 여기로 되돌린다.
          useSearchParams 는 프리렌더된 라우트에서 **가장 가까운 Suspense 경계까지**
          클라이언트 렌더로 돌린다. 배너만 경계 안에 두면 나머지 화면은 정적으로 남는다
          (이펙트 + setState 로 읽으면 렌더가 한 번 더 연쇄된다).
        */}
        <Suspense fallback={null}>
          <CallbackError />
        </Suspense>

        {state === 'error' && <ErrorBanner>{message}</ErrorBanner>}

        {state === 'sent' ? (
          <div className="rounded-lg border border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
            <strong className="font-medium">{email}</strong> 로 링크를 보냈습니다.
            <br />
            메일함과 <strong>스팸함</strong>을 확인해 주세요.
          </div>
        ) : (
          <div className="space-y-3">
            <button
              type="button"
              onClick={signInWithGoogle}
              disabled={state === 'sending'}
              className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
            >
              <GoogleMark />
              Google 계정으로 계속
            </button>

            {showEmail ? (
              <form onSubmit={signInWithEmail} className="space-y-2 pt-1">
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
            ) : (
              <button
                type="button"
                onClick={() => setShowEmail(true)}
                className="w-full py-1 text-xs text-neutral-500 underline hover:text-neutral-700 dark:hover:text-neutral-300"
              >
                이메일 링크로 로그인
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  )
}

/** ?error= 로 실려 온 콜백 실패 메시지 */
function CallbackError() {
  const error = useSearchParams().get('error')
  if (!error) return null
  return <ErrorBanner>{error}</ErrorBanner>
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      {children}
    </div>
  )
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" className="size-4" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.01-2.34Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  )
}
