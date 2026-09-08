'use client'

import { createBrowserClient } from '@supabase/ssr'

/** 브라우저용. anon 키는 번들에 노출되므로 RLS 가 유일한 방어선이다. */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
