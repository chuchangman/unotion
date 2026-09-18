'use client'

/**
 * 회의 녹음 → 받아쓰기.
 *
 * 마이크를 20초씩 끊어 서버로 보내고, 돌아온 글을 그때그때 문서에 적는다.
 * 회의가 끝난 뒤가 아니라 **회의 도중에** 기록이 쌓이는 게 요점이다.
 *
 * ★ 순서가 이 파일의 전부다 — 회의는 다시 열리지 않는다.
 *
 *     녹음 → IndexedDB 저장 → 전송 → 글이 문서에 들어감 → **그제서야** 삭제
 *
 *   오디오는 서버에 남기지 않는다. 그래서 전사가 실패하면 그 구간은 영영 없다.
 *   먼저 저장해 두면 키가 없든, 한도를 넘었든, 와이파이가 끊겼든, 탭이 죽었든
 *   오디오는 남는다. 다음에 이 페이지를 열면 "이어서 받아쓰기" 가 뜬다.
 *
 *   같은 이유로 **전사가 막혀도 녹음은 멈추지 않는다.** 예전에는 키가 없으면
 *   녹음을 중단했는데, 그건 회의를 통째로 버리는 것과 같다.
 *
 * ★ 왜 구간마다 MediaRecorder 를 새로 만드는가
 *   `start(timeslice)` 로 잘라 받은 두 번째 이후 조각에는 webm 헤더가 없다.
 *   그것만 떼서 전사 API 에 보내면 "Invalid file format" 으로 거절한다.
 *   stop() → start() 로 매번 **완결된 파일**을 만드는 게 유일하게 튼튼한 방법이다.
 *   경계에서 수 ms 가 비지만 사람 말소리에서는 들리지 않는 수준이다.
 *   (마이크 스트림 자체는 계속 열어 둔다 — 권한 재요청도, 끊김도 없다.)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Mic, Square, Pause, Play, Loader2, Upload, TriangleAlert, ShieldAlert, Download, Trash2,
} from 'lucide-react'
import {
  SEGMENT_MS,
  AUDIO_BITS_PER_SECOND,
  SILENCE_RMS,
  SILENCE_AUTOSTOP_MS,
  CONTEXT_TAIL_CHARS,
  MAX_AUDIO_BYTES,
  ACCEPTED_AUDIO_EXTENSIONS,
  pickRecorderMime,
  extensionForMime,
  formatOffset,
} from '@/lib/transcribe'
import {
  type PendingSegment,
  putSegment,
  deleteSegment,
  deleteSegments,
  listSegments,
  markAttempt,
  downloadSegments,
  storeAvailable,
} from '@/lib/meeting-store'

type Phase = 'idle' | 'recording' | 'paused' | 'finishing'

export type MeetingRecorderProps = {
  pageId: string
  /** 녹음 시작 — 문서에 회의 제목 블록을 넣을 기회다 */
  onSessionStart: (startedAt: Date) => void
  /** 구간 하나가 글이 됐다. offsetMs 는 회의 시작부터의 경과 시간 (-1 이면 없음) */
  onTranscript: (text: string, offsetMs: number) => void
  onSessionEnd: () => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 구간 하나를 서버로 보낸다.
 *
 * 컴포넌트 밖에 둔다 — 상태를 읽지 않고 큐에서 그대로 부르기 때문이다
 * (Editor.tsx 의 saveUpdate 와 같은 이유).
 *
 * 429·5xx 는 **한 번만** 다시 시도한다. 회의는 계속 흘러가고 있어서
 * 재시도를 길게 물고 있으면 뒤 구간들이 줄줄이 밀린다. 어차피 실패해도
 * 오디오는 IndexedDB 에 남으므로 나중에 이어서 받아쓸 수 있다.
 */
async function postSegment(
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
       * (그래서 proxy.ts 의 matcher 가 이 경로를 제외한다 — 여기는 2차 방어다).
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

/** 녹음 한 판 동안 유지되는 가변 상태. 렌더에는 쓰지 않는다 */
type Session = {
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
}

const emptySession = (): Session => ({
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
 * ★ 컴포넌트 밖에 두는 이유.
 *   useCallback 안에서 자기 자신을 부르면 React 컴파일러가 막는다
 *   ("accessed before it is declared" — 선언 전 접근이라 값이 갱신되지 않는다).
 *   상태를 읽지 않고 Session 하나만 만지는 함수라 밖에 두는 게 맞다.
 *
 * 무음 여부는 판단하지 않고 peak 을 그대로 넘긴다 — 버릴지 말지는 정책이고,
 * 정책은 상태를 가진 컴포넌트 쪽에 있어야 한다.
 */
function recordSegment(
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

export function MeetingRecorder({
  pageId,
  onSessionStart,
  onTranscript,
  onSessionEnd,
}: MeetingRecorderProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [pending, setPending] = useState(0)
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  /**
   * 소리가 작아 건너뛴 구간 수.
   *
   * 화면에 내보내는 게 요점이다. 예전에는 조용히 버려서, 마이크가 안 잡히는
   * 회의가 끝날 때까지 아무도 몰랐다 — 사용자가 본 건 "하나도 안 됨" 뿐이었다.
   */
  const [skipped, setSkipped] = useState(0)

  /** 아직 글이 되지 못하고 보관 중인 구간들 */
  const [stored, setStored] = useState<PendingSegment[]>([])
  const [recovering, setRecovering] = useState(false)
  /** 전송은 막혔지만 녹음은 계속하는 상태 */
  const [holding, setHolding] = useState(false)
  /** IndexedDB 를 못 써서 오디오를 지킬 수 없는 상태 */
  const [unprotected, setUnprotected] = useState(false)

  const session = useRef<Session>(emptySession())

  /**
   * 콜백을 ref 에 담아 둔다. 녹음 루프는 마운트 내내 같은 클로저를 쓰는데,
   * 부모가 콜백을 새로 만들 때마다 루프를 다시 깔 수는 없기 때문이다.
   */
  const handlers = useRef({ onSessionStart, onTranscript, onSessionEnd })
  useEffect(() => {
    handlers.current = { onSessionStart, onTranscript, onSessionEnd }
  }, [onSessionStart, onTranscript, onSessionEnd])

  /** 보관함을 다시 읽어 화면에 반영한다 */
  const refreshStored = useCallback(async () => {
    setStored(await listSegments(pageId))
  }, [pageId])

  // ── 이 페이지에 받아쓰지 못한 구간이 남아 있는지 (지난 회의 / 지난 탭)
  useEffect(() => {
    let alive = true
    void listSegments(pageId).then((rows) => {
      if (alive) setStored(rows)
    })
    return () => { alive = false }
  }, [pageId])

  // ── 정리. 어떤 경로로 끝나든 여기를 지난다
  const teardown = useCallback(() => {
    const s = session.current
    s.active = false
    if (s.segmentTimer) clearTimeout(s.segmentTimer)
    if (s.levelTimer) clearInterval(s.levelTimer)
    s.segmentTimer = null
    s.levelTimer = null
    s.recorder = null
    s.stream?.getTracks().forEach((t) => t.stop())
    s.stream = null
    void s.audioCtx?.close().catch(() => {})
    s.audioCtx = null
    s.analyser = null
    s.samples = null
    setLevel(0)
  }, [])

  useEffect(() => teardown, [teardown])

  // ── 경과 시간 표시 (녹음 중에만 돈다)
  useEffect(() => {
    if (phase !== 'recording') return
    const id = setInterval(() => {
      const s = session.current
      setElapsed(s.accumulated + (performance.now() - s.resumedAt))
    }, 500)
    return () => clearInterval(id)
  }, [phase])

  /**
   * 녹음 중 탭을 닫으려 하면 붙잡는다.
   * 저장이 끝난 구간은 IndexedDB 에 있어 안전하지만, **지금 녹음 중인 20초**는
   * 아직 어디에도 없다. 그것만은 경고할 값어치가 있다.
   */
  useEffect(() => {
    if (phase === 'idle') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [phase])

  /**
   * 구간을 큐에 넣는다. 큐 순서가 곧 문서에 적히는 순서다.
   *
   * ★ 순서가 중요하다 — 저장이 전송보다 **먼저**다.
   *   전송이 성공해 글이 문서에 들어간 뒤에만 지운다. 그 사이 어디서 끊겨도
   *   오디오는 남는다.
   */
  const enqueue = useCallback(
    (seg: PendingSegment) => {
      const s = session.current
      setPending((n) => n + 1)
      s.queue = s.queue.then(async () => {
        /**
         * ★ 이 안에서 예외가 새어 나가면 안 된다.
         *   큐는 `s.queue = s.queue.then(...)` 로 이어 붙인 **하나의 체인**이다.
         *   한 번 거부 상태가 되면 뒤에 붙는 then 이 전부 건너뛰어져서,
         *   회의 나머지가 통째로 받아쓰기 없이 지나간다.
         */
        try {
          const saved = await putSegment(seg)
          if (!saved) setUnprotected(true)
          void refreshStored()

          // 전송이 막힌 상태 — 저장만 해 두고 넘어간다. 녹음은 계속된다
          if (s.holding) return

          const res = await postSegment(
            pageId, seg.blob, seg.filename, s.tail, SEGMENT_MS / 1000,
          )

          if (!res.ok) {
            setError(res.message)
            if (res.fatal) {
              s.holding = true
              setHolding(true)
            }
            await markAttempt(seg)
            void refreshStored()
            return // ★ 지우지 않는다
          }

          if (res.text) {
            setError('')
            s.tail = res.text.slice(-CONTEXT_TAIL_CHARS)
            handlers.current.onTranscript(res.text, seg.offsetMs)
          }

          // 글이 문서에 들어갔다(또는 버릴 무음이었다). 이제 지워도 된다
          await deleteSegment(seg.id)
          void refreshStored()
        } catch (err) {
          console.error('[meeting] 구간 처리 실패', err)
          setError('이 구간을 받아쓰지 못했습니다 — 오디오는 보관했습니다')
        } finally {
          setPending((n) => n - 1)
        }
      })
    },
    [pageId, refreshStored],
  )

  const stop = useCallback(() => {
    const s = session.current
    s.active = false
    if (s.segmentTimer) clearTimeout(s.segmentTimer)
    s.segmentTimer = null
    setPhase('finishing')

    /**
     * 마지막 구간까지 문서에 들어간 뒤에 끝낸다.
     * 여기서 바로 idle 로 가면 사용자는 끝난 줄 알고 탭을 닫는다.
     *
     * ★ 큐를 지금 읽으면 안 된다.
     *   마지막 구간은 recorder 의 stop 이벤트에서 큐에 들어가는데 그 이벤트는
     *   아직 안 일어났다. setTimeout 0 으로 한 틱 넘기는 것도 **보장이 아니다** —
     *   MediaRecorder 가 dataavailable/stop 을 언제 큐잉하는지는 명세가 정하지
     *   않는다. 그래서 틱을 세지 말고 stop 이벤트를 직접 기다린다.
     *
     *   onstop 은 recordSegment 에서 **먼저** 달아 놨으므로 아래 리스너보다
     *   앞서 실행된다 (리스너는 등록 순서대로 불린다).
     */
    const lastSegment = new Promise<void>((resolve) => {
      const rec = s.recorder
      if (!rec || rec.state === 'inactive') return resolve()
      rec.addEventListener('stop', () => resolve(), { once: true })
      // 상태가 그 사이에 바뀌면 stop() 이 던진다 — 그때는 기다릴 이벤트가 없다
      try { rec.stop() } catch { resolve() }
    })

    void lastSegment
      .then(() => s.queue)
      .finally(() => {
        teardown()
        setPhase('idle')
        setElapsed(0)
        void refreshStored()
        handlers.current.onSessionEnd()
      })
  }, [teardown, refreshStored])

  /**
   * 구간이 하나 만들어졌다. 버릴지 보낼지는 여기서 정한다.
   */
  const handleSegment = useCallback(
    (blob: Blob, offsetMs: number, filename: string, peak: number) => {
      const s = session.current
      if (blob.size === 0) return

      /**
       * 조용한 구간은 저장도 전송도 하지 않는다.
       * Whisper 는 무음을 받으면 유튜브 자막 상투어를 지어내기 때문이다
       * ("시청해주셔서 감사합니다" — lib/transcribe.ts 주석).
       *
       * ★ 단, peak 이 **정확히 0** 이면 무음이 아니라 **측정이 안 된 것**이다.
       *   진짜 조용한 방도 마이크 잡음 때문에 1e-5 수준은 나온다. 딱 0 은
       *   AudioContext 가 suspended 이거나 analyser 가 안 붙었다는 뜻이다.
       *   그 상태에서 구간을 버리면 회의 전체가 소리 없이 사라진다.
       *   측정을 못 믿겠으면 **보낸다** — 잘못 보내는 비용은 요금 몇 원이지만
       *   잘못 버리면 되돌릴 방법이 없다.
       */
      if (peak > 0 && peak < SILENCE_RMS) {
        s.silentMs += SEGMENT_MS
        setSkipped((n) => n + 1)
        if (s.silentMs >= SILENCE_AUTOSTOP_MS) {
          setError(
            `${Math.round(SILENCE_AUTOSTOP_MS / 60000)}분 동안 말소리가 없어 녹음을 끝냈습니다`,
          )
          stop()
        }
        return
      }

      s.silentMs = 0
      enqueue({
        id: crypto.randomUUID(),
        pageId,
        sessionId: s.sessionId,
        sessionStartedAt: s.sessionStartedAt,
        offsetMs,
        blob,
        mime: s.mime,
        filename,
        createdAt: Date.now(),
        attempts: 0,
      })
    },
    [pageId, enqueue, stop],
  )

  /**
   * 녹음 루프를 건다. 본체는 컴포넌트 밖 recordSegment 에 있다.
   *
   * handleSegment 를 루프에 **한 번** 넘겨 주고 그 뒤로는 재사용된다.
   * pageId 가 녹음 도중에 바뀌면 낡은 클로저가 되겠지만, 에디터는 페이지마다
   * key 로 리마운트되므로(page.tsx) 그런 일은 없다.
   */
  const startLoop = useCallback(() => {
    recordSegment(session.current, handleSegment)
  }, [handleSegment])

  const start = useCallback(async () => {
    setError('')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // 회의실 스피커폰을 쓰면 이 셋이 있고 없고가 정확도를 가른다
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          // 모노면 용량이 절반이고, 전사 품질에는 차이가 없다
          channelCount: 1,
        },
      })
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      setError(
        name === 'NotAllowedError'
          ? '마이크 권한이 거부됐습니다 — 주소창의 자물쇠 아이콘에서 허용해 주세요'
          : name === 'NotFoundError'
            ? '마이크를 찾지 못했습니다'
            : '마이크를 열지 못했습니다',
      )
      return
    }

    const s = session.current
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
    setHolding(false)
    setSkipped(0)
    setUnprotected(!storeAvailable())

    /**
     * 음량 측정용 그래프. 화면의 레벨 미터와 무음 판정이 같은 값을 쓴다 —
     * 사용자가 "지금 안 들어가고 있구나"를 눈으로 볼 수 있어야 한다.
     */
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
        const cur = session.current
        if (!cur.analyser || !cur.samples) return
        cur.analyser.getFloatTimeDomainData(cur.samples)
        let sum = 0
        for (const v of cur.samples) sum += v * v
        const rms = Math.sqrt(sum / cur.samples.length)
        if (rms > cur.peak) cur.peak = rms
        setLevel(rms)
      }, 100)
    } catch {
      /**
       * AudioContext 를 못 만들어도 녹음은 계속한다.
       * analyser 가 없으면 peak 이 0 으로 남는데, handleSegment 가 그걸
       * "측정 실패" 로 보고 **전부 보낸다.** 무음 걸러내기는 서버의
       * cleanTranscript 가 대신한다. 소리를 못 재는 것이 회의를 버릴 이유는 아니다.
       */
      console.warn('[meeting] 음량 측정을 켜지 못했습니다 — 무음 구간도 그대로 보냅니다')
    }

    handlers.current.onSessionStart(new Date(s.sessionStartedAt))
    setElapsed(0)
    setPhase('recording')
    startLoop()
  }, [startLoop])

  /**
   * 일시정지는 지금 구간을 끊어 보내고 다음 구간을 걸지 않는 것이다.
   * MediaRecorder 의 pause() 를 쓰면 타이머 잔여 시간까지 따로 관리해야 하는데,
   * 그렇게까지 할 이유가 없다 — 어차피 구간 단위로 잘라 보내는 구조다.
   */
  const pause = useCallback(() => {
    const s = session.current
    s.active = false
    if (s.segmentTimer) clearTimeout(s.segmentTimer)
    s.segmentTimer = null
    s.accumulated += performance.now() - s.resumedAt
    if (s.recorder && s.recorder.state !== 'inactive') s.recorder.stop()
    setLevel(0)
    setPhase('paused')
  }, [])

  const resume = useCallback(() => {
    const s = session.current
    s.resumedAt = performance.now()
    s.active = true
    s.silentMs = 0
    setPhase('recording')
    startLoop()
  }, [startLoop])

  /**
   * 보관 중인 구간을 순서대로 다시 받아쓴다.
   *
   * 키를 넣었거나, 세션을 새로 열었거나, 한도가 풀린 뒤에 누른다.
   * 하나라도 실패하면 거기서 멈춘다 — 같은 이유로 계속 실패할 것이고,
   * 남은 오디오는 그대로 보관된다.
   */
  const resumePending = useCallback(async () => {
    setRecovering(true)
    setError('')

    const rows = await listSegments(pageId)
    if (rows.length === 0) {
      setRecovering(false)
      setStored([])
      return
    }

    handlers.current.onSessionStart(new Date(rows[0].sessionStartedAt))

    let tail = ''
    for (const seg of rows) {
      const res = await postSegment(
        pageId, seg.blob, seg.filename, tail, SEGMENT_MS / 1000,
      )
      if (!res.ok) {
        setError(res.message)
        await markAttempt(seg)
        break
      }
      if (res.text) {
        tail = res.text.slice(-CONTEXT_TAIL_CHARS)
        handlers.current.onTranscript(res.text, seg.offsetMs)
      }
      await deleteSegment(seg.id)
    }

    handlers.current.onSessionEnd()
    await refreshStored()
    setRecovering(false)
    // 성공했다면 보류 상태도 풀린다
    session.current.holding = false
    setHolding(false)
  }, [pageId, refreshStored])

  const discardPending = useCallback(async () => {
    const ok = confirm(
      `보관 중인 녹음 ${stored.length}개를 버릴까요?\n오디오는 여기에만 있어서 되돌릴 수 없습니다.`,
    )
    if (!ok) return
    await deleteSegments(stored.map((s) => s.id))
    await refreshStored()
  }, [stored, refreshStored])

  /** 이미 있는 녹음 파일(줌·폰 녹음 등)을 통째로 받아쓴다 */
  const transcribeFile = useCallback(
    async (file: File) => {
      setError('')

      const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
      if (!(ACCEPTED_AUDIO_EXTENSIONS as readonly string[]).includes(ext)) {
        setError(`.${ext} 는 받아쓸 수 없습니다 (${ACCEPTED_AUDIO_EXTENSIONS.join(', ')})`)
        return
      }
      if (file.size > MAX_AUDIO_BYTES) {
        const mb = (file.size / 1024 / 1024).toFixed(1)
        setError(`파일이 너무 큽니다 (최대 25MB, 지금 ${mb}MB)`)
        return
      }

      setUploading(true)
      handlers.current.onSessionStart(new Date(file.lastModified))
      /**
       * 길이를 모른다. 원본 파일은 사용자 디스크에 그대로 있으므로
       * 실패해도 잃는 게 없다 — 라이브 녹음과 달리 보관할 필요가 없다.
       */
      const res = await postSegment(pageId, file, file.name, '', 0)
      setUploading(false)

      if (!res.ok) {
        setError(res.message)
        return
      }
      if (!res.text) {
        setError('말소리를 찾지 못했습니다')
        return
      }

      // 파일 전체를 한 번에 받아쓴 것이라 구간 시각이 없다
      handlers.current.onTranscript(res.text, -1)
      handlers.current.onSessionEnd()
    },
    [pageId],
  )

  const busy = phase === 'finishing' || uploading || recovering
  const storedMinutes = Math.max(1, Math.round((stored.length * SEGMENT_MS) / 60000))

  return (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {phase === 'idle' ? (
          <>
            <button
              type="button"
              onClick={() => void start()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <Mic className="size-3.5" />
              회의 녹음
            </button>

            <label className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200">
              {uploading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5" />
              )}
              {uploading ? '받아쓰는 중' : '녹음 파일'}
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  // 같은 파일을 다시 고를 수 있도록 값을 비운다
                  e.target.value = ''
                  if (file) void transcribeFile(file)
                }}
              />
            </label>
          </>
        ) : (
          <>
            <span
              role="status"
              className="flex items-center gap-2 rounded-md bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300"
            >
              <span
                aria-hidden
                className={`size-2 rounded-full bg-red-500 ${
                  phase === 'recording' ? 'animate-pulse' : 'opacity-40'
                }`}
              />
              {phase === 'finishing' ? '마무리 중' : formatOffset(elapsed)}
            </span>

            {/* 레벨 미터 — "지금 내 말이 들어가고 있나"에 답한다 */}
            <span
              aria-hidden
              className="h-1.5 w-20 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700"
            >
              <span
                className={`block h-full rounded-full transition-[width] duration-100 ${
                  level < SILENCE_RMS ? 'bg-neutral-400' : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.min(100, Math.round(level * 400))}%` }}
              />
            </span>

            {phase === 'recording' && (
              <button
                type="button"
                onClick={pause}
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <Pause className="size-3.5" />
                잠시 멈춤
              </button>
            )}
            {phase === 'paused' && (
              <button
                type="button"
                onClick={resume}
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <Play className="size-3.5" />
                이어서
              </button>
            )}

            <button
              type="button"
              onClick={stop}
              disabled={phase === 'finishing'}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
            >
              <Square className="size-3.5" />
              종료
            </button>

            {pending > 0 && (
              <span className="flex items-center gap-1.5 text-xs text-neutral-400">
                <Loader2 className="size-3 animate-spin" />
                받아쓰는 중 {pending}
              </span>
            )}
          </>
        )}
      </div>

      {/*
        전송이 막혔지만 녹음은 계속되는 상태.
        이 배너가 없으면 사용자는 받아쓰기가 되고 있다고 착각한다.
      */}
      {holding && phase !== 'idle' && (
        <p
          role="status"
          className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          <ShieldAlert className="mt-px size-3.5 shrink-0" />
          <span>
            받아쓰기는 멈췄지만 <strong>녹음은 계속 저장되고 있습니다.</strong>{' '}
            원인을 고친 뒤 아래 &ldquo;이어서 받아쓰기&rdquo; 를 누르면 그대로 받아쓸 수 있습니다.
          </span>
        </p>
      )}

      {/*
        소리가 작아 건너뛴 구간이 있으면 **반드시 보여 준다.**
        이걸 조용히 넘기면 마이크가 안 잡히는 회의를 끝까지 모른 채 진행한다.
      */}
      {skipped > 0 && phase !== 'idle' && (
        <p
          role="status"
          className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span>
            소리가 너무 작아 <strong>{skipped}개 구간</strong>을 건너뛰었습니다.
            위 막대가 초록색으로 움직이는지 보고, 안 움직이면 마이크 입력 장치를 확인하세요.
          </span>
        </p>
      )}

      {/* IndexedDB 를 못 쓰는 환경 — 실패하면 진짜로 날아간다는 걸 알려야 한다 */}
      {unprotected && phase !== 'idle' && (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-md bg-red-50 px-2.5 py-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200"
        >
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          이 브라우저에서는 오디오를 임시 보관할 수 없습니다 (시크릿 창이거나 저장 공간이 부족).
          받아쓰기가 실패하면 그 구간은 복구할 수 없습니다.
        </p>
      )}

      {/* 보관 중인 구간 — 지난 회의에서 남았거나 방금 실패한 것들 */}
      {stored.length > 0 && phase === 'idle' && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-900 dark:bg-amber-950">
          <p className="text-xs text-amber-900 dark:text-amber-100">
            아직 글이 되지 못한 녹음이 <strong>{stored.length}개</strong> 있습니다 (약 {storedMinutes}분).
            {' '}
            <span className="text-amber-700 dark:text-amber-300">
              {new Date(stored[0].sessionStartedAt).toLocaleString('ko-KR', {
                dateStyle: 'short',
                timeStyle: 'short',
              })}{' '}시작
            </span>
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => void resumePending()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md bg-amber-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {recovering ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              {recovering ? '받아쓰는 중' : '이어서 받아쓰기'}
            </button>
            <button
              type="button"
              onClick={() => downloadSegments(stored)}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:text-amber-200 dark:hover:bg-amber-900"
            >
              <Download className="size-3.5" />
              오디오 내려받기
            </button>
            <button
              type="button"
              onClick={() => void discardPending()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:text-amber-200 dark:hover:bg-amber-900"
            >
              <Trash2 className="size-3.5" />
              버리기
            </button>
          </div>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
        >
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  )
}
