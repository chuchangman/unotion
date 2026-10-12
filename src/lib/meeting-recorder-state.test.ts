import { describe, expect, it } from 'vitest'
import { INITIAL_RECORDER_STATE, recorderReducer, type RecorderEvent, type RecorderState } from './meeting-recorder-state'

const run = (events: RecorderEvent[], from: RecorderState = INITIAL_RECORDER_STATE) =>
  events.reduce(recorderReducer, from)

describe('recorderReducer', () => {
  it('녹음을 시작하면 녹음 중이 되고, 지난 판의 오류와 경과 시간은 지운다', () => {
    const s = run([{ type: 'error', message: '지난 오류' }, { type: 'elapsed', ms: 9_000 }, { type: 'sessionStarted', unprotected: false }])
    expect(s.activity).toEqual({ kind: 'session', stage: 'recording', holding: false, skipped: 0, unprotected: false })
    expect(s).toMatchObject({ error: '', elapsed: 0 })
  })

  it('판 안에서만 뜻이 있는 변경은 판이 끝난 뒤 늦게 와도 버린다', () => {
    const during = run([
      { type: 'sessionStarted', unprotected: false },
      { type: 'skipped' }, { type: 'skipped' }, { type: 'hold' }, { type: 'unprotected' },
      { type: 'stage', stage: 'paused' },
    ])
    expect(during.activity).toEqual({ kind: 'session', stage: 'paused', holding: true, skipped: 2, unprotected: true })

    const ended = run([{ type: 'sessionEnded' }], during)
    expect(ended.activity).toEqual({ kind: 'idle' })
    // 마지막 구간의 전사가 판이 끝난 뒤에 돌아온 경우
    expect(run([{ type: 'skipped' }, { type: 'hold' }, { type: 'stage', stage: 'recording' }], ended)).toBe(ended)
  })

  it('파일 업로드·복구·요약은 한 번에 하나, 녹음 중에는 시작하지 않는다', () => {
    const uploading = run([{ type: 'begin', kind: 'uploading' }])
    expect(uploading.activity).toEqual({ kind: 'uploading' })
    expect(run([{ type: 'begin', kind: 'summarizing' }], uploading)).toBe(uploading)
    expect(run([{ type: 'done' }], uploading).activity).toEqual({ kind: 'idle' })

    const recording = run([{ type: 'sessionStarted', unprotected: true }])
    expect(run([{ type: 'begin', kind: 'recovering' }], recording)).toBe(recording)
    // 녹음 중의 done 은 녹음을 끝내지 않는다
    expect(run([{ type: 'done' }], recording)).toBe(recording)
  })

  it('대기 중인 구간 수는 더하고 뺀 만큼이다', () => {
    const s = run([
      { type: 'pending', delta: 1 }, { type: 'pending', delta: 1 },
      { type: 'pending', delta: -1 }, { type: 'pending', delta: 1 },
    ])
    expect(s.pending).toBe(2)
  })
})
