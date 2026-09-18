/**
 * 아직 글이 되지 못한 녹음 구간을 브라우저에 붙잡아 둔다.
 *
 * ★ 이 파일이 있는 이유 — 회의는 다시 열리지 않는다.
 *
 *   오디오는 서버 어디에도 저장하지 않는다. 전사하고 버린다(그게 설계다).
 *   그래서 전사가 실패하면 그 20초는 **영영 없다.** 탭이 닫히거나, 와이파이가
 *   끊기거나, API 키가 만료되거나, 잔액이 떨어지면 회의가 통째로 날아간다.
 *   되돌릴 방법이 없다 — 파일 업로드와 달리 원본이 어디에도 없기 때문이다.
 *
 *   그래서 순서를 뒤집었다.
 *     녹음 → **여기에 저장** → 전송 → 글이 문서에 들어감 → 그제서야 삭제
 *   중간에 무슨 일이 생겨도 오디오는 남는다. 다음에 그 페이지를 열면
 *   "받아쓰지 못한 구간이 있습니다" 가 뜨고, 이어서 받아쓰거나 내려받을 수 있다.
 *
 * IndexedDB 는 이미 쓰고 있다 (Editor.tsx 의 y-indexeddb). 다만 그건 Yjs 전용이라
 * Blob 을 넣을 수 없어서 저장소를 따로 연다. 새 의존성은 없다 — 원시 IDB 다.
 */

const DB_NAME = 'notion-meeting-audio'
const DB_VERSION = 1
const STORE = 'segments'
const PAGE_INDEX = 'by_page'

export type PendingSegment = {
  id: string
  pageId: string
  /** 한 번의 녹음(회의)을 묶는 id. 복구 화면이 회의 단위로 보여 주려고 쓴다 */
  sessionId: string
  /** 회의가 시작된 시각 (epoch ms) */
  sessionStartedAt: number
  /** 회의 내 경과 시간(ms). -1 이면 통째로 올린 파일이라 시각이 없다 */
  offsetMs: number
  blob: Blob
  mime: string
  filename: string
  /** 이 구간이 녹음된 시각 (epoch ms) */
  createdAt: number
  /** 전사를 시도한 횟수. 계속 실패하는 구간을 구분한다 */
  attempts: number
}

/**
 * IndexedDB 를 못 쓰는 환경이 있다 (사파리 프라이빗, 용량 초과, 기업 정책).
 * 그때 녹음 자체가 막히면 안 되므로 **모든 함수는 실패해도 던지지 않는다.**
 * 대신 storeAvailable() 이 false 가 되고, 호출부는 "보호 없이 녹음 중"을 알린다.
 */
let broken = false

export function storeAvailable(): boolean {
  return !broken && typeof indexedDB !== 'undefined'
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex(PAGE_INDEX, 'pageId', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 열기 실패'))
    req.onblocked = () => reject(new Error('IndexedDB 가 다른 탭에 잠겨 있습니다'))
  })
}

/** 트랜잭션 하나를 돌리고 닫는다. 실패는 전부 여기서 흡수한다 */
async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  if (!storeAvailable()) return null

  let db: IDBDatabase
  try {
    db = await open()
  } catch (err) {
    // 한 번 실패하면 계속 실패한다. 매번 시도해서 로그를 더럽히지 않는다
    broken = true
    console.error('[meeting-store] 열지 못했습니다 — 오디오 보호 없이 진행합니다', err)
    return null
  }

  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 요청 실패'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 트랜잭션 중단'))
    })
  } catch (err) {
    /**
     * 여기서 가장 흔한 실패는 QuotaExceededError 다.
     * 긴 회의를 여러 번 남겨 두면 닿는다. 던지지 않고 null 을 주되,
     * 호출부(녹음기)가 "보호 없이 녹음 중" 배너를 띄운다.
     */
    console.error('[meeting-store] 작업 실패', err)
    return null
  } finally {
    db.close()
  }
}

/**
 * 구간을 저장한다. **전송보다 먼저** 불러야 한다.
 * 실패하면 false — 호출부는 계속 녹음하되 사용자에게 알린다.
 */
export async function putSegment(seg: PendingSegment): Promise<boolean> {
  const res = await withStore<IDBValidKey>('readwrite', (s) => s.put(seg))
  return res !== null
}

/** 글이 문서에 들어간 뒤에만 부른다 */
export async function deleteSegment(id: string): Promise<void> {
  await withStore<undefined>('readwrite', (s) => s.delete(id))
}

export async function deleteSegments(ids: string[]): Promise<void> {
  for (const id of ids) await deleteSegment(id)
}

/** 녹음된 순서대로 돌려준다 — 문서에 적히는 순서가 곧 이 순서다 */
export async function listSegments(pageId: string): Promise<PendingSegment[]> {
  const rows = await withStore<PendingSegment[]>('readonly', (s) =>
    s.index(PAGE_INDEX).getAll(pageId),
  )
  if (!rows) return []
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

/** 재시도 횟수만 올린다. 계속 실패하는 구간을 화면에서 구분하기 위한 것 */
export async function markAttempt(seg: PendingSegment): Promise<void> {
  await putSegment({ ...seg, attempts: seg.attempts + 1 })
}

/**
 * 남은 구간을 파일로 내려준다 — 마지막 탈출구다.
 *
 * 구간들은 각각 완결된 webm 파일이라 하나로 합칠 수 없다(이어 붙이면 깨진다).
 * 그래서 순번을 붙여 따로 내려받는다. 순번대로 열면 회의 순서 그대로다.
 */
export function downloadSegments(segments: PendingSegment[]): void {
  segments.forEach((seg, i) => {
    const stamp = new Date(seg.sessionStartedAt)
      .toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })
      .replace(/[^0-9]/g, '')
    const ext = seg.filename.split('.').pop() || 'webm'
    const name = `회의_${stamp}_${String(i + 1).padStart(3, '0')}.${ext}`

    const url = URL.createObjectURL(seg.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    // 즉시 해제하면 일부 브라우저에서 저장이 취소된다
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  })
}
