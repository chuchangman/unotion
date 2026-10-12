'use client'

/**
 * 회의 녹음 엔진 — 전사 큐, 보관(IndexedDB), 무음 정책. 화면은 MeetingRecorder.tsx 가 그린다.
 * 여기에는 JSX 가 없다. 마이크 · MediaRecorder · 음량 측정 같은 브라우저 절차는
 * lib/meeting-session.ts, 화면 상태(reducer)는 lib/meeting-recorder-state.ts 에 있다.
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
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { summarizePage } from '@/app/actions/meetings'
import type { MeetingSummary } from '@/lib/transcribe'
import {
  SEGMENT_MS,
  SILENCE_RMS,
  SILENCE_AUTOSTOP_MS,
  CONTEXT_TAIL_CHARS,
  MAX_AUDIO_BYTES,
  ACCEPTED_AUDIO_EXTENSIONS,
} from '@/lib/transcribe'
import {
  type PendingSegment,
  type MeetingRecording,
  listRecordings,
  deleteRecording,
  putSegment,
  deleteSegment,
  deleteSegments,
  listSegments,
  markAttempt,
  storeAvailable,
} from '@/lib/meeting-store'
import { INITIAL_RECORDER_STATE, recorderReducer } from '@/lib/meeting-recorder-state'
import {
  type Session,
  emptySession,
  postSegment,
  recordSegment,
  openMicrophone,
  micErrorMessage,
  beginSession,
  openLevelMeter,
  startFullRecorder,
  stopAndWait,
  saveFullRecording,
  closeSession,
} from '@/lib/meeting-session'

// ─────────────────────────────────────────── 훅

export type MeetingRecorderCallbacks = {
  pageId: string
  /** 녹음 시작 — 문서에 회의 제목 블록을 넣을 기회다 */
  onSessionStart: (startedAt: Date) => void
  /** 구간 하나가 글이 됐다. offsetMs 는 회의 시작부터의 경과 시간 (-1 이면 없음) */
  onTranscript: (text: string, offsetMs: number) => void
  onSessionEnd: () => void
  /**
   * 요약에 넣을 문서 전문. 에디터가 들고 있는 걸 그대로 준다 —
   * 서버의 plain_text 는 몇 초 디바운스로 저장되는 파생본이라
   * 녹음이 끝나자마자 요약하면 마지막 몇 문장이 빠진다.
   */
  getTranscript: () => string
  /** 요약 결과를 문서에 넣는다. 전문은 건드리지 않는다 */
  onSummary: (summary: MeetingSummary) => void
}

export function useMeetingRecorder({
  pageId,
  onSessionStart,
  onTranscript,
  onSessionEnd,
  getTranscript,
  onSummary,
}: MeetingRecorderCallbacks) {
  const [state, dispatch] = useReducer(recorderReducer, INITIAL_RECORDER_STATE)
  /** 이 페이지에 보관된 통짜 녹음들 (내려받기/버리기용) */
  const [recordings, setRecordings] = useState<MeetingRecording[]>([])
  /** 아직 글이 되지 못하고 보관 중인 구간들 */
  const [stored, setStored] = useState<PendingSegment[]>([])

  const session = useRef<Session>(emptySession())
  const setError = useCallback((message: string) => dispatch({ type: 'error', message }), [])

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

  const refreshRecordings = useCallback(async () => {
    setRecordings(await listRecordings(pageId))
  }, [pageId])

  // ── 이 페이지에 받아쓰지 못한 구간이 남아 있는지 (지난 회의 / 지난 탭)
  useEffect(() => {
    let alive = true
    void listSegments(pageId).then((rows) => {
      if (alive) setStored(rows)
    })
    void listRecordings(pageId).then((rows) => {
      if (alive) setRecordings(rows)
    })
    return () => { alive = false }
  }, [pageId])

  // ── 정리. 어떤 경로로 끝나든 여기를 지난다
  const teardown = useCallback(() => {
    closeSession(session.current)
    dispatch({ type: 'level', level: 0 })
  }, [])

  useEffect(() => teardown, [teardown])

  const stage = state.activity.kind === 'session' ? state.activity.stage : null

  // ── 경과 시간 표시 (녹음 중에만 돈다)
  useEffect(() => {
    if (stage !== 'recording') return
    const id = setInterval(() => {
      const s = session.current
      dispatch({ type: 'elapsed', ms: s.accumulated + (performance.now() - s.resumedAt) })
    }, 500)
    return () => clearInterval(id)
  }, [stage])

  /**
   * 녹음 중 탭을 닫으려 하면 붙잡는다.
   * 저장이 끝난 구간은 IndexedDB 에 있어 안전하지만, **지금 녹음 중인 20초**는
   * 아직 어디에도 없다. 그것만은 경고할 값어치가 있다.
   */
  useEffect(() => {
    if (!stage) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [stage])

  /**
   * 녹음 중에는 화면이 꺼지지 않게 붙잡는다.
   *
   * 휴대폰을 테이블에 올려 두고 녹음하면 30초쯤 뒤 화면이 잠기고, 잠긴 브라우저는
   * 마이크를 끊는다 (특히 iOS). 회의 내내 화면을 톡톡 건드릴 수는 없다.
   *
   * 화면 잠금 해제권은 탭이 가려지면 브라우저가 **스스로 거둬 간다.** 그래서
   * 다시 보이게 될 때마다 새로 받는다. 지원하지 않는 브라우저면 그냥 넘어간다.
   */
  const recording = stage !== null
  useEffect(() => {
    if (!recording || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let alive = true
    const acquire = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const next = await navigator.wakeLock.request('screen')
        if (alive) lock = next
        else void next.release()
      } catch {
        // 배터리 절약 모드 등에서 거절된다 — 녹음 자체는 계속된다
      }
    }
    void acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', acquire)
      void lock?.release()
    }
  }, [recording])

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
      dispatch({ type: 'pending', delta: 1 })
      s.queue = s.queue.then(async () => {
        /**
         * ★ 이 안에서 예외가 새어 나가면 안 된다.
         *   큐는 `s.queue = s.queue.then(...)` 로 이어 붙인 **하나의 체인**이다.
         *   한 번 거부 상태가 되면 뒤에 붙는 then 이 전부 건너뛰어져서,
         *   회의 나머지가 통째로 받아쓰기 없이 지나간다.
         */
        try {
          const saved = await putSegment(seg)
          if (!saved) dispatch({ type: 'unprotected' })
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
              dispatch({ type: 'hold' })
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
          dispatch({ type: 'pending', delta: -1 })
        }
      })
    },
    [pageId, refreshStored, setError],
  )

  const stop = useCallback(() => {
    const s = session.current
    // active 를 끄기 **전에** 재야 마지막 구간까지 길이에 들어간다
    const durationMs = s.accumulated + (s.active ? performance.now() - s.resumedAt : 0)
    s.active = false
    if (s.segmentTimer) clearTimeout(s.segmentTimer)
    s.segmentTimer = null
    dispatch({ type: 'stage', stage: 'finishing' })

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
     *   onstop 은 recordSegment 에서 **먼저** 달아 놨으므로 stopAndWait 의 리스너보다
     *   앞서 실행된다 (리스너는 등록 순서대로 불린다).
     *
     * 통짜 녹음도 같은 방식으로 기다린다. 안 그러면 마지막 5초 조각이 들어오기 전에
     * Blob 을 만들게 된다.
     */
    void Promise.all([stopAndWait(s.recorder), stopAndWait(s.fullRecorder)])
      .then(async () => {
        const saved = await saveFullRecording(s, pageId, durationMs)
        if (saved === false) dispatch({ type: 'unprotected' })
        if (saved !== null) void refreshRecordings()
        return s.queue
      })
      .finally(() => {
        teardown()
        dispatch({ type: 'sessionEnded' })
        void refreshStored()
        handlers.current.onSessionEnd()
      })
  }, [teardown, refreshStored, refreshRecordings, pageId])

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
        dispatch({ type: 'skipped' })
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
    [pageId, enqueue, stop, setError],
  )

  /**
   * 녹음 루프를 건다. 본체는 훅 밖 recordSegment 에 있다.
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
      stream = await openMicrophone()
    } catch (err) {
      setError(micErrorMessage(err))
      return
    }

    const s = session.current
    beginSession(s, stream)

    // 화면의 레벨 미터와 무음 판정이 같은 값을 쓴다 — "지금 안 들어가고 있구나" 를 눈으로 볼 수 있어야 한다
    const metered = await openLevelMeter(s, stream, (level) => dispatch({ type: 'level', level }))
    if (!metered) {
      /**
       * AudioContext 를 못 만들어도 녹음은 계속한다.
       * analyser 가 없으면 peak 이 0 으로 남는데, handleSegment 가 그걸
       * "측정 실패" 로 보고 **전부 보낸다.** 무음 걸러내기는 서버의
       * cleanTranscript 가 대신한다. 소리를 못 재는 것이 회의를 버릴 이유는 아니다.
       */
      console.warn('[meeting] 음량 측정을 켜지 못했습니다 — 무음 구간도 그대로 보냅니다')
    }

    // 통짜 녹음이 안 돼도 받아쓰기는 계속한다. 화자 분리용 부가 기능이다
    if (!startFullRecorder(s, stream)) console.warn('[meeting] 통짜 녹음을 시작하지 못했습니다')

    handlers.current.onSessionStart(new Date(s.sessionStartedAt))
    dispatch({ type: 'sessionStarted', unprotected: !storeAvailable() })
    startLoop()
  }, [startLoop, setError])

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
    // 통짜 녹음기는 끊지 않고 멈춘다 — 재개하면 같은 파일로 이어진다
    if (s.fullRecorder?.state === 'recording') s.fullRecorder.pause()
    dispatch({ type: 'level', level: 0 })
    dispatch({ type: 'stage', stage: 'paused' })
  }, [])

  const resume = useCallback(() => {
    const s = session.current
    s.resumedAt = performance.now()
    s.active = true
    s.silentMs = 0
    if (s.fullRecorder?.state === 'paused') s.fullRecorder.resume()
    dispatch({ type: 'stage', stage: 'recording' })
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
    dispatch({ type: 'begin', kind: 'recovering' })
    setError('')

    const rows = await listSegments(pageId)
    if (rows.length === 0) {
      dispatch({ type: 'done' })
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
    dispatch({ type: 'done' })
    // 성공했다면 보류 상태도 풀린다
    session.current.holding = false
    dispatch({ type: 'release' })
  }, [pageId, refreshStored, setError])

  const discardPending = useCallback(async () => {
    const ok = confirm(
      `보관 중인 녹음 ${stored.length}개를 버릴까요?\n오디오는 여기에만 있어서 되돌릴 수 없습니다.`,
    )
    if (!ok) return
    await deleteSegments(stored.map((s) => s.id))
    await refreshStored()
  }, [stored, refreshStored])

  const discardRecording = useCallback(async (id: string) => {
    if (!confirm('이 녹음을 버릴까요? 오디오는 여기에만 있어서 되돌릴 수 없습니다.')) return
    await deleteRecording(id)
    await refreshRecordings()
  }, [refreshRecordings])

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

      dispatch({ type: 'begin', kind: 'uploading' })
      handlers.current.onSessionStart(new Date(file.lastModified))
      /**
       * 길이를 모른다. 원본 파일은 사용자 디스크에 그대로 있으므로
       * 실패해도 잃는 게 없다 — 라이브 녹음과 달리 보관할 필요가 없다.
       */
      const res = await postSegment(pageId, file, file.name, '', 0)
      dispatch({ type: 'done' })

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
    [pageId, setError],
  )

  /**
   * 회의 전문을 요약한다.
   *
   * 요약은 전문을 **대체하지 않는다** — 문서 맨 위에 덧붙일 뿐이고 원문은 그대로
   * 남는다. 요약 모델은 합의된 적 없는 항목을 "결정사항" 으로 적는 버릇이 있어서,
   * 틀렸을 때 사람이 원문과 대조할 수 있어야 한다 (lib/core/summarize.ts 주석).
   */
  const summarize = useCallback(async () => {
    setError('')
    const transcript = getTranscript().trim()
    if (transcript.length < 50) {
      setError('요약할 내용이 너무 짧습니다 — 회의 기록을 먼저 만드세요')
      return
    }

    dispatch({ type: 'begin', kind: 'summarizing' })
    const res = await summarizePage(pageId, transcript)
    dispatch({ type: 'done' })

    if (!res.ok) {
      setError(res.message)
      return
    }
    onSummary(res.data)
  }, [pageId, getTranscript, onSummary, setError])

  return {
    state,
    stored,
    recordings,
    actions: {
      start, pause, resume, stop, resumePending, discardPending, discardRecording,
      transcribeFile, summarize,
    },
  }
}
