'use client'

/**
 * 회의 녹음 → 받아쓰기 화면.
 *
 * 마이크를 20초씩 끊어 서버로 보내고, 돌아온 글을 그때그때 문서에 적는다.
 * 회의가 끝난 뒤가 아니라 **회의 도중에** 기록이 쌓이는 게 요점이다.
 *
 * 녹음·전송·보관의 순서와 그 이유는 useMeetingRecorder.ts 에 있다.
 * 이 파일은 그 상태를 그리기만 한다.
 */
import {
  Mic, Square, Pause, Play, Loader2, Upload, TriangleAlert, ShieldAlert, Download, Trash2,
  Sparkles,
} from 'lucide-react'
import { SEGMENT_MS, SILENCE_RMS, formatOffset } from '@/lib/transcribe'
import { downloadRecording, downloadSegments } from '@/lib/meeting-store'
import { useMeetingRecorder, type MeetingRecorderCallbacks } from './useMeetingRecorder'

export type MeetingRecorderProps = MeetingRecorderCallbacks

export function MeetingRecorder(props: MeetingRecorderProps) {
  const { state, stored, recordings, actions } = useMeetingRecorder(props)
  const { activity, pending, level, elapsed, error } = state

  const session = activity.kind === 'session' ? activity : null
  const stage = session?.stage ?? null
  const uploading = activity.kind === 'uploading'
  const recovering = activity.kind === 'recovering'
  const summarizing = activity.kind === 'summarizing'
  const busy = stage === 'finishing' || uploading || recovering || summarizing
  const storedMinutes = Math.max(1, Math.round((stored.length * SEGMENT_MS) / 60000))

  return (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {!session ? (
          <>
            <button
              type="button"
              onClick={() => void actions.start()}
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
                  if (file) void actions.transcribeFile(file)
                }}
              />
            </label>

            {/* 요약 — 녹음이 없어도 손으로 적은 회의록에 쓸 수 있다 */}
            <button
              type="button"
              onClick={() => void actions.summarize()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            >
              {summarizing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              {summarizing ? '요약하는 중' : '회의 요약'}
            </button>
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
                  stage === 'recording' ? 'animate-pulse' : 'opacity-40'
                }`}
              />
              {stage === 'finishing' ? '마무리 중' : formatOffset(elapsed)}
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

            {stage === 'recording' && (
              <button
                type="button"
                onClick={actions.pause}
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <Pause className="size-3.5" />
                잠시 멈춤
              </button>
            )}
            {stage === 'paused' && (
              <button
                type="button"
                onClick={actions.resume}
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <Play className="size-3.5" />
                이어서
              </button>
            )}

            <button
              type="button"
              onClick={actions.stop}
              disabled={stage === 'finishing'}
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
        휴대폰 녹음 — 다른 앱으로 넘어가거나 화면을 끄면 브라우저가 마이크를 끊는다.
        화면 꺼짐은 useMeetingRecorder 가 막지만, 앱 전환은 막을 수 없어 알려 둔다.
      */}
      {session && (
        <p className="text-xs text-neutral-400 md:hidden">
          녹음하는 동안 이 화면을 켜 둔 채로 두세요. 다른 앱으로 넘어가면 녹음이 끊길 수 있습니다.
        </p>
      )}

      {/*
        전송이 막혔지만 녹음은 계속되는 상태.
        이 배너가 없으면 사용자는 받아쓰기가 되고 있다고 착각한다.
      */}
      {session?.holding && (
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
      {session && session.skipped > 0 && (
        <p
          role="status"
          className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span>
            소리가 너무 작아 <strong>{session.skipped}개 구간</strong>을 건너뛰었습니다.
            위 막대가 초록색으로 움직이는지 보고, 안 움직이면 마이크 입력 장치를 확인하세요.
          </span>
        </p>
      )}

      {/* IndexedDB 를 못 쓰는 환경 — 실패하면 진짜로 날아간다는 걸 알려야 한다 */}
      {session?.unprotected && (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-md bg-red-50 px-2.5 py-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200"
        >
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          이 브라우저에서는 오디오를 임시 보관할 수 없습니다 (시크릿 창이거나 저장 공간이 부족).
          받아쓰기가 실패하면 그 구간은 복구할 수 없습니다.
        </p>
      )}

      {/*
        보관된 회의 녹음. 받아쓰기와 별개로 **오디오 원본**이 남는다.
        화자 분리를 붙이기 전까지는 이걸 내려받아 측정 도구에 넣어 본다
        (npm run check:diarization).
      */}
      {recordings.length > 0 && !session && (
        <div className="rounded-md border border-neutral-200 px-3 py-2.5 dark:border-neutral-800">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            보관된 회의 녹음 <strong>{recordings.length}개</strong>
          </p>
          <ul className="mt-1.5 space-y-1">
            {recordings.map((rec) => (
              <li key={rec.id} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-neutral-600 dark:text-neutral-300">
                  {new Date(rec.startedAt).toLocaleString('ko-KR', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </span>
                <span className="text-neutral-400">
                  {formatOffset(rec.durationMs)} · {(rec.bytes / 1024 / 1024).toFixed(1)}MB
                </span>
                <button
                  type="button"
                  onClick={() => downloadRecording(rec)}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                >
                  <Download className="size-3.5" />
                  내려받기
                </button>
                <button
                  type="button"
                  onClick={() => void actions.discardRecording(rec.id)}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                >
                  <Trash2 className="size-3.5" />
                  버리기
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 보관 중인 구간 — 지난 회의에서 남았거나 방금 실패한 것들 */}
      {stored.length > 0 && !session && (
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
              onClick={() => void actions.resumePending()}
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
              onClick={() => void actions.discardPending()}
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
