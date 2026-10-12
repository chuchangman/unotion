/**
 * 회의 녹음 한 판 — 마이크, MediaRecorder, 음량 측정, 구간 전송. React 를 모른다.
 * 상태와 정책(무음을 버릴지, 언제 멈출지)은 components/editor/useMeetingRecorder.ts 에 있다.
 * 여기 함수들은 Session 하나를 만지고, 알릴 일은 콜백으로 돌려준다.
 *
 * ★ 왜 구간마다 MediaRecorder 를 새로 만드는가
 *   `start(timeslice)` 로 잘라 받은 두 번째 이후 조각에는 webm 헤더가 없다.
 *   그것만 떼서 전사 API 에 보내면 "Invalid file format" 으로 거절한다.
 *   stop() → start() 로 매번 **완결된 파일**을 만드는 게 유일하게 튼튼한 방법이다.
 *   경계에서 수 ms 가 비지만 사람 말소리에서는 들리지 않는 수준이다.
 *   (마이크 스트림 자체는 계속 열어 둔다 — 권한 재요청도, 끊김도 없다.)
 */
import {
  SEGMENT_MS,
  AUDIO_BITS_PER_SECOND,
  pickRecorderMime,
  extensionForMime,
} from '@/lib/transcribe'
import { putRecording } from '@/lib/meeting-store'

// ─────────────────────────────────────────── 전송

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 구간 하나를 서버로 보낸다.
 *
 * 훅 밖에 둔다 — 상태를 읽지 않고 큐에서 그대로 부르기 때문이다.
 *
 * 429·5xx 는 **한 번만** 다시 시도한다. 회의는 계속 흘러가고 있어서
 * 재시도를 길게 물고 있으면 뒤 구간들이 줄줄이 밀린다. 어차피 실패해도
 * 오디오는 IndexedDB 에 남으므로 나중에 이어서 받아쓸 수 있다.
 */
export async function postSegment(
  pageId: string,
  audio: Blob,
  filename: string,
  context: string,
  seconds: number,
  language = 'ko',
): Promise<{ ok: true; text: string } | { ok: false; message: string; fatal: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const form = new FormData()
    // 파일명이 없으면 서버가 컨테이너를 못 읽는다 (lib/core/transcribe.ts 주석)
    form.append('audio', audio, filename)
    form.append('pageId', pageId)
    form.append('language', language)
    form.append('seconds', String(seconds))
    if (context) form.append('context', context)

    let res: Response
    try {
      res = await fetch('/api/transcribe', { method: 'POST', body: form })
    } catch {
      // 네트워크가 끊겼다. 회의 중 와이파이 전환에서 흔하다 — 한 번 더 해 본다
      if (attempt === 0) {
        await sleep(1500)
        continue
      }
      return { ok: false, message: '네트워크 오류로 이 구간을 받아쓰지 못했습니다', fatal: false }
    }

    if (res.ok) {
      /**
       * 200 이어도 JSON 이 아닐 수 있다. 앞단에서 리다이렉트를 먹으면
       * fetch 가 그걸 따라가 로그인 HTML 을 200 으로 들고 온다
       * (그래서 proxy.ts 의 matcher 가 api/ 를 제외한다 — 여기는 2차 방어다).
       */
      const data = (await res.json().catch(() => null)) as { text?: string } | null
      if (!data) return { ok: false, message: '받아쓰기 응답을 읽지 못했습니다', fatal: false }
      return { ok: true, text: data.text ?? '' }
    }

    const body = (await res.json().catch(() => ({}))) as { message?: string }
    const message = body.message ?? '받아쓰기에 실패했습니다'

    /**
     * 되풀이해도 소용없는 실패 — 전송만 멈추고 **녹음은 계속한다.**
     *   401  세션 만료 (새로고침하면 풀린다)
     *   403  이 문서 편집 권한 없음
     *   503  키 없음 / 외부 전송 차단 / 하루 한도 초과
     * 전부 사람이 뭔가 고쳐야 풀리는 것들이라 구간마다 두드려 봐야 소용없다.
     * 그동안 오디오는 계속 쌓이므로, 고친 뒤 "이어서 받아쓰기" 를 누르면 된다.
     */
    const fatal = res.status === 401 || res.status === 403 || res.status === 503
    if (fatal || attempt === 1) return { ok: false, message, fatal }

    // 429 / 5xx — 잠깐 쉬고 한 번 더
    await sleep(res.status === 429 ? 3000 : 1500)
  }
  return { ok: false, message: '받아쓰기에 실패했습니다', fatal: false }
}

// ─────────────────────────────────────────── 녹음 한 판

/** 녹음 한 판 동안 유지되는 가변 상태. 렌더에는 쓰지 않는다 */
export type Session = {
  stream: MediaStream | null
  recorder: MediaRecorder | null
  audioCtx: AudioContext | null
  analyser: AnalyserNode | null
  /** getFloatTimeDomainData 가 ArrayBuffer 백업 버퍼를 요구한다 (SharedArrayBuffer 불가) */
  samples: Float32Array<ArrayBuffer> | null
  levelTimer: ReturnType<typeof setInterval> | null
  segmentTimer: ReturnType<typeof setTimeout> | null
  mime: string
  /** 지금 구간에서 관측한 최대 RMS — 무음 판정 */
  peak: number
  /** 지금 구간이 시작된 회의 내 시각(ms) */
  segmentAt: number
  /** 일시정지 전까지 누적된 녹음 시간(ms) */
  accumulated: number
  /** 마지막으로 재개한 시각 (performance.now) */
  resumedAt: number
  /** 다음 구간을 이어서 시작할지. onstop 핸들러가 읽는다 */
  active: boolean
  /** 전사 요청 직렬화 — 큐 순서가 곧 문서에 적히는 순서다 */
  queue: Promise<void>
  /** 앞 구간의 꼬리. 다음 구간의 문맥 prompt 로 넘어간다 */
  tail: string
  /** 이번 녹음을 묶는 id */
  sessionId: string
  sessionStartedAt: number
  /** 연속으로 조용했던 시간(ms). 일정 시간을 넘으면 스스로 끝낸다 */
  silentMs: number
  /** 전송 보류 중인가. 큐가 읽어서 저장만 하고 넘어간다 */
  holding: boolean
  /**
   * 회의 전체를 담는 두 번째 녹음기.
   *
   * 20초 구간들은 각각 완결된 webm 이라 **이어 붙일 수 없다.** 그런데 화자 분리는
   * 전체를 들어야 누가 누군지 가른다. 그래서 같은 스트림에 녹음기를 하나 더 붙여
   * 통짜로 받아 둔다. 이쪽은 stop()/start() 로 끊지 않으므로 pause() 를 그대로 쓴다.
   */
  fullRecorder: MediaRecorder | null
  fullParts: Blob[]
}

export const emptySession = (): Session => ({
  stream: null,
  recorder: null,
  audioCtx: null,
  analyser: null,
  samples: null,
  levelTimer: null,
  segmentTimer: null,
  mime: '',
  peak: 0,
  segmentAt: 0,
  accumulated: 0,
  resumedAt: 0,
  active: false,
  queue: Promise.resolve(),
  tail: '',
  fullRecorder: null,
  fullParts: [],
  sessionId: '',
  sessionStartedAt: 0,
  silentMs: 0,
  holding: false,
})

/**
 * 구간 하나를 녹음한다. 끝나면 **스스로 다음 구간을 건다.**
 *
 * 재귀처럼 보이지만 스택은 쌓이지 않는다 — onstop 은 이벤트 루프에서 새로 불린다.
 *
 * ★ 훅 밖에 두는 이유.
 *   useCallback 안에서 자기 자신을 부르면 React 컴파일러가 막는다
 *   ("accessed before it is declared" — 선언 전 접근이라 값이 갱신되지 않는다).
 *   상태를 읽지 않고 Session 하나만 만지는 함수라 밖에 두는 게 맞다.
 *
 * 무음 여부는 판단하지 않고 peak 을 그대로 넘긴다 — 버릴지 말지는 정책이고,
 * 정책은 상태를 가진 쪽(훅)에 있어야 한다.
 */
export function recordSegment(
  s: Session,
  onSegment: (blob: Blob, offsetMs: number, filename: string, peak: number) => void,
) {
  if (!s.active || !s.stream) return

  const rec = new MediaRecorder(s.stream, {
    ...(s.mime ? { mimeType: s.mime } : {}),
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
  })
  s.recorder = rec
  s.peak = 0
  s.segmentAt = s.accumulated + (performance.now() - s.resumedAt)

  const parts: Blob[] = []
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) parts.push(e.data)
  }

  rec.onstop = () => {
    const peak = s.peak
    const at = s.segmentAt
    const blob = new Blob(parts, { type: s.mime || 'audio/webm' })

    // 다음 구간을 **먼저** 건다. 전사 대기와 녹음이 겹쳐야 빈 구간이 안 생긴다
    if (s.active) recordSegment(s, onSegment)

    onSegment(blob, at, `segment.${extensionForMime(s.mime || 'audio/webm')}`, peak)
  }

  rec.start()
  s.segmentTimer = setTimeout(() => {
    if (rec.state !== 'inactive') rec.stop()
  }, SEGMENT_MS)
}

/** 회의용 마이크 */
export function openMicrophone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      // 회의실 스피커폰을 쓰면 이 셋이 있고 없고가 정확도를 가른다
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      // 모노면 용량이 절반이고, 전사 품질에는 차이가 없다
      channelCount: 1,
    },
  })
}

export function micErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  return name === 'NotAllowedError'
    ? '마이크 권한이 거부됐습니다 — 주소창의 자물쇠 아이콘에서 허용해 주세요'
    : name === 'NotFoundError'
      ? '마이크를 찾지 못했습니다'
      : '마이크를 열지 못했습니다'
}

/** 새 녹음 한 판을 연다 — 지난 판의 값을 전부 지운다 */
export function beginSession(s: Session, stream: MediaStream) {
  s.stream = stream
  s.mime = pickRecorderMime()
  s.accumulated = 0
  s.resumedAt = performance.now()
  s.tail = ''
  s.queue = Promise.resolve()
  s.active = true
  s.sessionId = crypto.randomUUID()
  s.sessionStartedAt = Date.now()
  s.silentMs = 0
  s.holding = false
}

/**
 * 음량 측정용 그래프를 붙인다. 100ms 마다 RMS 를 재서 구간 최대값(peak)을 갱신하고
 * onLevel 로 알린다. 못 붙이면 false — peak 이 0 으로 남는다.
 */
export async function openLevelMeter(
  s: Session,
  stream: MediaStream,
  onLevel: (rms: number) => void,
): Promise<boolean> {
  try {
    const ctx = new AudioContext()
    /**
     * ★ resume() 를 반드시 부른다.
     *
     * 이 AudioContext 는 getUserMedia 를 **await 한 뒤에** 만들어진다.
     * 그 시점에는 브라우저가 보기에 사용자 제스처가 끝나 있어서,
     * 크롬 자동재생 정책상 context 가 suspended 로 태어날 수 있다.
     * suspended 면 getFloatTimeDomainData 가 **전부 0** 을 돌려주고,
     * 그러면 모든 구간이 무음으로 판정돼 회의가 통째로 버려진다.
     */
    if (ctx.state === 'suspended') await ctx.resume()

    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    ctx.createMediaStreamSource(stream).connect(analyser)
    s.audioCtx = ctx
    s.analyser = analyser
    s.samples = new Float32Array(analyser.fftSize)

    s.levelTimer = setInterval(() => {
      if (!s.analyser || !s.samples) return
      s.analyser.getFloatTimeDomainData(s.samples)
      let sum = 0
      for (const v of s.samples) sum += v * v
      const rms = Math.sqrt(sum / s.samples.length)
      if (rms > s.peak) s.peak = rms
      onLevel(rms)
    }, 100)
    return true
  } catch {
    return false
  }
}

/**
 * 회의 전체를 담는 통짜 녹음기를 같은 스트림에 붙인다 (Session.fullRecorder 주석).
 * 5초마다 조각을 받아 두는 건 메모리에 한 번에 몰리지 않게 하려는 것이고,
 * 이쪽은 중간에 stop() 하지 않으므로 조각들이 하나의 완결된 파일이 된다.
 */
export function startFullRecorder(s: Session, stream: MediaStream): boolean {
  try {
    const full = new MediaRecorder(stream, {
      ...(s.mime ? { mimeType: s.mime } : {}),
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    })
    s.fullParts = []
    full.ondataavailable = (e) => { if (e.data.size > 0) s.fullParts.push(e.data) }
    full.start(5000)
    s.fullRecorder = full
    return true
  } catch {
    s.fullRecorder = null
    return false
  }
}

/**
 * 녹음기를 멈추고 stop 이벤트까지 기다린다 — 마지막 조각(dataavailable)은 그보다 먼저 온다.
 * 이미 멈췄거나 없으면 바로 끝난다. 상태가 그 사이 바뀌어 stop() 이 던지면 기다릴 이벤트가 없다.
 */
export function stopAndWait(rec: MediaRecorder | null): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!rec || rec.state === 'inactive') return resolve()
    rec.addEventListener('stop', () => resolve(), { once: true })
    try { rec.stop() } catch { resolve() }
  })
}

/**
 * 통짜 녹음을 보관한다. 구간들과 달리 **자동으로 지우지 않는다** — 사용자가 내려받거나
 * 버릴 때까지 남는다. 화자 분리의 재료이기도 하다.
 * 받은 조각이 없으면 null, 있으면 IndexedDB 에 저장됐는지.
 */
export async function saveFullRecording(s: Session, pageId: string, durationMs: number): Promise<boolean | null> {
  if (s.fullParts.length === 0) return null
  const mime = s.mime || 'audio/webm'
  const blob = new Blob(s.fullParts, { type: mime })
  s.fullParts = []
  return putRecording({
    id: s.sessionId || crypto.randomUUID(),
    pageId,
    startedAt: s.sessionStartedAt,
    durationMs,
    bytes: blob.size,
    blob,
    mime,
  })
}

/** 한 판을 정리한다. 어떤 경로로 끝나든(중지 · 언마운트 · 오류) 여기를 지난다 */
export function closeSession(s: Session) {
  s.active = false
  if (s.segmentTimer) clearTimeout(s.segmentTimer)
  if (s.levelTimer) clearInterval(s.levelTimer)
  s.segmentTimer = null
  s.levelTimer = null
  s.recorder = null
  if (s.fullRecorder && s.fullRecorder.state !== 'inactive') {
    try { s.fullRecorder.stop() } catch { /* 이미 멈췄다 */ }
  }
  s.fullRecorder = null
  s.stream?.getTracks().forEach((t) => t.stop())
  s.stream = null
  void s.audioCtx?.close().catch(() => {})
  s.audioCtx = null
  s.analyser = null
  s.samples = null
}
