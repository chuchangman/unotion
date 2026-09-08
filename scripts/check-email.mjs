/**
 * SMTP 설정 검증.
 *
 *   npm run check:email -- 받을주소@example.com
 *
 * 앱이 실제로 쓰는 경로(signInWithOtp)를 그대로 태워서
 * Supabase 가 돌려주는 오류를 사람이 읽을 수 있게 풀어준다.
 */
import { createClient } from '@supabase/supabase-js'
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

const to = process.argv.slice(2).find((a) => a.includes('@'))
if (!to) {
  console.error('\n사용법: npm run check:email -- 받을주소@example.com\n')
  process.exit(1)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
if (!url || !key) {
  console.error('\n.env.local 에 NEXT_PUBLIC_SUPABASE_URL / ANON_KEY 가 없습니다.\n')
  process.exit(1)
}

const origin = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'
const redirectTo = `${origin}/auth/callback?next=%2F`

console.log(`\n발송 대상 : ${to}`)
console.log(`리다이렉트: ${redirectTo}\n`)

const supabase = createClient(url, key)
const { error } = await supabase.auth.signInWithOtp({
  email: to,
  options: { emailRedirectTo: redirectTo },
})

if (!error) {
  console.log('발송 요청 성공.')
  console.log('→ 메일함과 **스팸함**을 확인하세요.')
  console.log('→ 메일이 안 오면 Supabase 대시보드 Logs → Auth 에서 SMTP 오류를 확인하세요.\n')
  process.exit(0)
}

const msg = error.message ?? ''
console.error(`실패 (status ${error.status ?? '?'}): ${msg}\n`)

const hints = [
  [/rate limit|too many|429/i,
    '레이트 리밋입니다.\n' +
    '  · 커스텀 SMTP 를 아직 안 켰다면 내장 메일의 시간당 2통 제한입니다 → docs/smtp-setup.md 2단계\n' +
    '  · 켰다면 Authentication → Rate Limits 를 30 이상으로 올리세요\n' +
    '  · 동일 주소 재요청은 60초 쿨다운이 있습니다'],
  [/redirect|not allowed|invalid.*url/i,
    `리다이렉트 주소가 허용목록에 없습니다.\n` +
    `  Authentication → URL Configuration → Redirect URLs 에 ${origin}/** 를 추가하세요`],
  [/smtp|relay|sender|authentic|550|535/i,
    'SMTP 인증/발신자 문제입니다.\n' +
    '  · Sender email 이 Username 과 정확히 같은지 확인 (Gmail 은 불일치를 거부합니다)\n' +
    '  · 앱 비밀번호 16자리에 공백이 섞이지 않았는지 확인\n' +
    '  · Google 계정 비밀번호를 바꿨다면 앱 비밀번호가 무효화됐습니다 → 재발급'],
  [/signup|disabled|not enabled/i,
    'Authentication → Providers → Email 이 꺼져 있거나 신규 가입이 막혀 있습니다.'],
]

const hint = hints.find(([re]) => re.test(msg))?.[1]
console.error(hint
  ? `짚어볼 것:\n  ${hint}\n`
  : '짚어볼 것:\n  Supabase 대시보드 → Logs → Auth 에서 원본 오류를 확인하세요.\n')
process.exit(1)
