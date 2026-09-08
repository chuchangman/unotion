'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { createClient } from '@/lib/supabase/client'

export function SignOut() {
  const router = useRouter()
  const [pending, start] = useTransition()

  const signOut = () =>
    start(async () => {
      await createClient().auth.signOut()
      router.push('/login')
      router.refresh()
    })

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={pending}
      className="rounded-lg border border-neutral-300 px-4 py-2 font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      로그아웃
    </button>
  )
}
