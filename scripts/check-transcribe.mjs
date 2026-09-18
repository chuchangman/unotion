/**
 * 받아쓰기 후처리 점검.
 *
 *   npm run check:transcribe
 *
 * DB 도 네트워크도 쓰지 않는다. src/lib/transcribe.ts 의 순수 함수만 본다.
 *
 * 왜 필요한가: 무음 구간에서 Whisper 가 지어낸 유튜브 자막 상투어를 거르는
 * 필터가 **조용히 깨질 수 있다.** 실제로 처음 구현은 목록을 정규화 전 형태로
 * 적어 두고 정규화 후 값과 비교해서, 영어 항목만 걸리고 정작 주 대상인
 * 한국어 환각은 전부 통과했다. 화면에는 아무 이상도 없고 회의록에
 * "시청해주셔서 감사합니다" 가 섞여 들어갈 뿐이라 알아채기 어렵다.
 *
 * 반대 방향도 같이 본다 — 진짜 발화를 잘라먹으면 더 큰 사고다.
 * 부분 일치로 지우면 "네 감사합니다, 그럼 다음 안건으로" 가 통째로 사라진다.
 */
// .ts 를 직접 부르려고 node 가 아니라 tsx 로 실행한다 (package.json 참고).
// tsx 는 devDependency 에 이미 있다 — 새 의존성은 없다.
import { cleanTranscript, formatOffset, extensionForMime } from '../src/lib/transcribe.ts'

let failed = 0

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`)
  } else {
    failed++
    console.log(`  \x1b[31m✗\x1b[0m ${label}`)
    console.log(`      받음: ${JSON.stringify(got)}`)
    console.log(`      기대: ${JSON.stringify(want)}`)
  }
}

console.log('\n무음 환각은 버린다 (구간 **전체**가 그 문장일 때만)')
check('시청 감사', cleanTranscript('시청해주셔서 감사합니다.'), '')
check('띄어쓰기 변형', cleanTranscript('시청해 주셔서 감사합니다'), '')
check('구독/좋아요', cleanTranscript('구독과 좋아요 부탁드립니다!'), '')
check('다음 영상', cleanTranscript('다음 영상에서 만나요~'), '')
check('영어 자막', cleanTranscript('Thanks for watching!'), '')
check('Amara 자막', cleanTranscript('Subtitles by the Amara.org community'), '')
check('같은 말 반복', cleanTranscript('네. 네. 네. 네. 네.'), '')
check('빈 입력', cleanTranscript('   '), '')

console.log('\n진짜 발화는 절대 자르지 않는다 (부분 일치 금지)')
check(
  '"감사합니다" 가 들어간 발화',
  cleanTranscript('네 감사합니다, 그럼 다음 안건으로 넘어가죠.'),
  '네 감사합니다, 그럼 다음 안건으로 넘어가죠.',
)
check('짧은 긍정', cleanTranscript('네, 좋습니다.'), '네, 좋습니다.')
check(
  '서로 다른 문장 여러 개',
  cleanTranscript('네. 그건 아니고요. 다시 볼게요.'),
  '네. 그건 아니고요. 다시 볼게요.',
)
check(
  '"구독" 이 안건인 회의',
  cleanTranscript('구독 모델로 갈지 이번 주에 정합시다.'),
  '구독 모델로 갈지 이번 주에 정합시다.',
)

console.log('\n회의록에 찍히는 경과 시각')
check('0초', formatOffset(0), '00:00')
check('20초', formatOffset(20_000), '00:20')
check('1시간 5분 3초', formatOffset(3_903_000), '1:05:03')

console.log('\n전사 API 가 알아볼 파일 확장자')
check('webm/opus', extensionForMime('audio/webm;codecs=opus'), 'webm')
check('mp4 (사파리)', extensionForMime('audio/mp4'), 'mp4')
check('모르는 형식', extensionForMime('audio/weird'), 'webm')

if (failed > 0) {
  console.error(`\n\x1b[31m${failed}건 실패\x1b[0m\n`)
  process.exit(1)
}
console.log('\n\x1b[32m전부 통과\x1b[0m\n')
