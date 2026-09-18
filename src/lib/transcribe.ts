/**
 * 회의 받아쓰기(Whisper)에서 **브라우저와 서버가 함께 쓰는** 값들.
 *
 * 한쪽만 고치면 조용히 어긋난다 — 녹음기가 30MB 짜리를 만들어 보내고 서버가
 * 거절하는 식이다. lib/upload.ts 와 같은 이유로 한 파일에 모아 둔다.
 */

/**
 * 전사 API 의 업로드 상한.
 *
 * 우리가 정한 값이 아니라 **API 가 거절하는 선**이다. 넘기면 413 이 아니라
 * 400 + "Maximum content size limit exceeded" 로 오기 때문에, 미리 막지 않으면
 * 사용자는 이유를 알 수 없는 실패만 본다.
 */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024

/**
 * 조각 하나의 길이.
 *
 * 짧을수록 화면에 빨리 뜨지만 (1) API 호출 수가 늘고 (2) 조각 경계에서 잘리는
 * 단어가 많아진다. 20초면 "말하고 20~25초 뒤에 글이 올라온다" 정도라,
 * 회의 중에 곁눈질로 확인하기에 무리가 없다.
 */
export const SEGMENT_MS = 20_000

/**
 * 앞 조각의 꼬리를 다음 조각의 prompt 로 넘긴다. 그 길이.
 *
 * Whisper 는 조각 사이의 문맥을 모르기 때문에, 이게 없으면 같은 고유명사가
 * 조각마다 다르게 적힌다 ("싸피 / SSAFY / 사피"). prompt 로 앞말을 주면
 * 표기가 붙잡힌다. 길게 줄수록 좋아지지만 토큰도 같이 늘어서 200자에서 끊는다.
 */
export const CONTEXT_TAIL_CHARS = 200

/** 녹음 비트레이트. opus 24kbps 면 말소리는 충분하고 1시간이 ~11MB 다. */
export const AUDIO_BITS_PER_SECOND = 24_000

/**
 * 무음 판정 문턱 (0~1 RMS).
 *
 * 이 값보다 조용한 구간은 보내지 않는다. 비용 때문만이 아니라 아래
 * HALLUCINATIONS 주석의 이유 때문이다.
 *
 * ★ 낮게 잡는다. 이 판정이 틀리면 **회의가 조용히 사라진다.**
 *
 *   처음에 0.006 으로 뒀다가 실제 회의에서 20초 구간 하나만 전송되고
 *   나머지가 전부 버려졌다 (audit_log 에 page.transcribe 가 1건뿐이었다).
 *   노트북 내장 마이크에 조금 떨어져 앉으면 말소리 RMS 가 그 아래로 내려간다.
 *
 *   잘못 보내면 요금이 조금 더 나오고 서버가 환각을 한 번 더 거르면 그만이다.
 *   잘못 버리면 되돌릴 방법이 없다. 비대칭이 크므로 관대한 쪽으로 붙인다.
 *   (측정 자체가 실패한 경우는 아예 보낸다 — MeetingRecorder 의 handleSegment 참고)
 */
export const SILENCE_RMS = 0.0015

/**
 * 이만큼 계속 조용하면 녹음을 **스스로 끝낸다.**
 *
 * 회의가 끝났는데 종료를 안 누르는 일은 반드시 생긴다 (노트북을 덮고 나간다).
 * 그대로 두면 빈 방을 밤새 녹음한다. 무음 구간은 어차피 전송하지 않으므로
 * 요금이 곧바로 새지는 않지만, 마이크와 배터리를 계속 잡고 있고
 * 잡음이 문턱을 넘길 때마다 하루 상한을 갉아먹는다.
 *
 * 10분은 "생각하느라 조용한 회의"와 "아무도 없는 방"을 가르는 선이다.
 */
export const SILENCE_AUTOSTOP_MS = 10 * 60 * 1000

/**
 * 무음 구간에서 Whisper 가 지어내는 문장들.
 *
 * ★ 이건 우리 버그가 아니라 모델의 알려진 실패 모드다.
 *   Whisper 의 학습 데이터에 유튜브 자막이 대량으로 들어갔기 때문에,
 *   소리가 없는 구간을 받으면 자막 상투어를 "들었다고" 확신한다.
 *   한국어에서는 거의 항상 아래 몇 개 중 하나다.
 *
 *   조용한 회의(생각하는 시간, 화면 공유 중 침묵)에서 문서에
 *   "시청해주셔서 감사합니다" 가 박히는 걸 실제로 봤다.
 *
 * 방어는 두 겹이다. 브라우저에서 RMS 로 무음 조각을 안 보내고(1차),
 * 그래도 통과한 것은 여기서 거른다(2차). 마이크 잡음이 문턱을 넘기는 경우가 있다.
 *
 * ★ 조각 **전체**가 이 문장일 때만 버린다. 부분 일치로 지우면
 *   "네 감사합니다, 그럼 다음 안건으로" 같은 진짜 발화가 잘려 나간다.
 */
const HALLUCINATIONS = [
  '시청해주셔서 감사합니다',
  '구독과 좋아요 부탁드립니다',
  '구독 좋아요 알림설정',
  '다음 영상에서 만나요',
  '다음 시간에 만나요',
  '한글자막 by',
  '자막 제공',
  'Thanks for watching',
  'Thank you for watching',
  'Please subscribe',
  'Subtitles by the Amara.org community',
  '。',
  'you',
]

/**
 * 비교용 정규화 — 공백·문장부호·대소문자를 지운다.
 *
 * 띄어쓰기 변형("시청해주셔서" / "시청해 주셔서")이 실제로 둘 다 나오기 때문에
 * 공백을 지워야 한 줄로 잡힌다.
 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s.,!?~♪♬"'·\-—]/g, '')
}

/**
 * ★ 목록도 **같은 정규화를 거쳐** 둔다.
 *
 *   예전에는 위 배열을 그대로 비교했다. 그러면 정규화된 입력
 *   ("시청해주셔서감사합니다") 과 원문 항목("시청해주셔서 감사합니다") 이
 *   공백 하나 때문에 영영 안 맞는다 — 영어 항목만 우연히 걸리고
 *   정작 주 대상인 한국어 환각은 전부 통과했다.
 */
const HALLUCINATION_KEYS = new Set(HALLUCINATIONS.map(normalize))

/**
 * 전사 결과를 문서에 넣어도 되는 형태로 다듬는다.
 * 버릴 조각이면 빈 문자열을 돌려준다 — 호출부는 빈 문자열이면 아무것도 넣지 않는다.
 */
export function cleanTranscript(raw: string): string {
  const text = raw.trim()
  if (!text) return ''

  const key = normalize(text)
  if (!key) return ''
  if (HALLUCINATION_KEYS.has(key)) return ''

  /**
   * 같은 말이 계속 반복되는 것도 무음 구간의 증상이다
   * ("네. 네. 네. 네. ..."). 세 번 넘게 똑같이 반복되면 버린다.
   */
  const parts = text.split(/(?<=[.?!])\s+/).filter(Boolean)
  if (parts.length > 3 && new Set(parts.map(normalize)).size === 1) return ''

  return text
}

/** `01:23:45` / 1시간 미만이면 `23:45` */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = String(total % 60).padStart(2, '0')
  const m = String(Math.floor(total / 60) % 60).padStart(2, '0')
  const h = Math.floor(total / 3600)
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`
}

/**
 * 브라우저가 실제로 **녹음할 수 있는** 컨테이너를 고른다.
 *
 * 크롬·파이어폭스는 webm/opus, 사파리는 mp4/aac 만 된다.
 * 지원하지 않는 값을 MediaRecorder 에 주면 NotSupportedError 로 죽으므로
 * 반드시 isTypeSupported 로 물어보고 쓴다. 전부 실패하면 빈 문자열을 주고
 * (브라우저 기본값) 서버는 확장자를 파일명에서 읽는다.
 */
export function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ]
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
}

/** 전사 API 가 알아볼 수 있게 MIME 에서 파일 확장자를 만든다 */
export function extensionForMime(mime: string): string {
  const base = mime.split(';')[0].trim()
  const table: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
  }
  return table[base] ?? 'webm'
}

/**
 * 전사 API 가 받는 확장자 (파일 업로드로 받아쓰기 할 때 검사용).
 * 목록은 OpenAI 전사 엔드포인트 기준이다.
 */
export const ACCEPTED_AUDIO_EXTENSIONS = [
  'flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm',
] as const
