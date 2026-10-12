/**
 * 회의 녹음기의 화면 상태 — reducer 하나다 (components/editor/useMeetingRecorder.ts 가 쓴다).
 *
 * 예전에는 phase 와 따로 노는 불리언(uploading · recovering · summarizing · holding …)이
 * 여럿이라, 어떤 조합이 가능한지 알려면 파일 전체를 읽어야 했다. 실제로는 녹음 중에
 * 파일 업로드·복구·요약을 할 수 없다(버튼이 안 보인다) — 그걸 타입으로 드러낸다.
 *
 * React 도 브라우저 API 도 쓰지 않는 순수 함수라 Node 에서 바로 테스트한다.
 */

/**
 * 지금 하고 있는 일. 하나만 할 수 있다.
 *   session   녹음 한 판 (녹음 중 / 잠시 멈춤 / 마무리 중)
 *   uploading 녹음 파일을 통째로 받아쓰는 중
 *   recovering 보관된 구간을 이어서 받아쓰는 중
 *   summarizing 회의 요약 중
 */
export type Activity =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'recovering' }
  | { kind: 'summarizing' }
  | {
      kind: 'session'
      stage: 'recording' | 'paused' | 'finishing'
      /** 전송은 막혔지만 녹음은 계속하는 상태 */
      holding: boolean
      /**
       * 소리가 작아 건너뛴 구간 수.
       * 화면에 내보내는 게 요점이다. 예전에는 조용히 버려서, 마이크가 안 잡히는
       * 회의가 끝날 때까지 아무도 몰랐다 — 사용자가 본 건 "하나도 안 됨" 뿐이었다.
       */
      skipped: number
      /** IndexedDB 를 못 써서 오디오를 지킬 수 없는 상태 */
      unprotected: boolean
    }

export type RecorderState = {
  activity: Activity
  /** 전사 큐에 들어가 아직 끝나지 않은 구간 수 */
  pending: number
  /** 지금 음량 (RMS). 레벨 미터와 무음 판정이 같은 값을 쓴다 */
  level: number
  /** 녹음 경과 시간 (ms) */
  elapsed: number
  error: string
}

export type RecorderEvent =
  | { type: 'sessionStarted'; unprotected: boolean }
  | { type: 'stage'; stage: 'recording' | 'paused' | 'finishing' }
  | { type: 'sessionEnded' }
  | { type: 'hold' }
  | { type: 'release' }
  | { type: 'skipped' }
  | { type: 'unprotected' }
  | { type: 'pending'; delta: 1 | -1 }
  | { type: 'level'; level: number }
  | { type: 'elapsed'; ms: number }
  | { type: 'error'; message: string }
  | { type: 'begin'; kind: 'uploading' | 'recovering' | 'summarizing' }
  | { type: 'done' }

export const INITIAL_RECORDER_STATE: RecorderState = { activity: { kind: 'idle' }, pending: 0, level: 0, elapsed: 0, error: '' }

/** 녹음 한 판 안에서만 뜻이 있는 변경 — 판이 끝난 뒤 늦게 온 건 버린다 */
function inSession(state: RecorderState, fn: (a: Extract<Activity, { kind: 'session' }>) => Activity): RecorderState {
  return state.activity.kind === 'session' ? { ...state, activity: fn(state.activity) } : state
}

export function recorderReducer(state: RecorderState, e: RecorderEvent): RecorderState {
  switch (e.type) {
    case 'sessionStarted':
      return {
        ...state,
        activity: { kind: 'session', stage: 'recording', holding: false, skipped: 0, unprotected: e.unprotected },
        elapsed: 0,
        error: '',
      }
    case 'stage':
      return inSession(state, (a) => ({ ...a, stage: e.stage }))
    case 'sessionEnded':
      return { ...state, activity: { kind: 'idle' }, elapsed: 0, level: 0 }
    case 'hold':
      return inSession(state, (a) => ({ ...a, holding: true }))
    case 'release':
      return inSession(state, (a) => ({ ...a, holding: false }))
    case 'skipped':
      return inSession(state, (a) => ({ ...a, skipped: a.skipped + 1 }))
    case 'unprotected':
      return inSession(state, (a) => ({ ...a, unprotected: true }))
    case 'pending':
      return { ...state, pending: state.pending + e.delta }
    case 'level':
      return { ...state, level: e.level }
    case 'elapsed':
      return { ...state, elapsed: e.ms }
    case 'error':
      return { ...state, error: e.message }
    case 'begin':
      return state.activity.kind === 'idle' ? { ...state, activity: { kind: e.kind } } : state
    case 'done':
      return state.activity.kind === 'session' ? state : { ...state, activity: { kind: 'idle' } }
  }
}
