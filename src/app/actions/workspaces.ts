'use server'

/**
 * 프로젝트 룸 웹 어댑터. 로직은 없다 — lib/core/workspaces 를 부르고 직렬화만 한다.
 *
 * ★ 이 파일만 활성 룸 쿠키를 쓴다.
 *   쿠키는 서버 액션이나 라우트 핸들러에서만 설정할 수 있어서, 렌더 경로
 *   (getSessionContext)는 읽기만 하고 바꾸는 건 전부 여기를 거친다.
 *
 * ★ redirect() 를 쓰지 않는다.
 *   redirect 는 특수 예외를 던지는데 아래 run() 의 catch 가 그걸 삼켜서
 *   이동이 조용히 죽는다. 그래서 갈 곳(pageId)을 돌려주고 이동은 클라이언트가 한다 —
 *   pages.ts 의 createPage 와 같은 방식이다.
 */
import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { requireActor, ACTIVE_WORKSPACE_COOKIE } from '@/lib/auth'
import * as Workspaces from '@/lib/core/workspaces'
import { assertWorkspaceMember } from '@/lib/core/permissions'
import { DomainError } from '@/lib/core/errors'

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string }

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    if (err instanceof DomainError) {
      return { ok: false, code: err.code, message: err.message }
    }
    console.error('[action:workspaces] 예상치 못한 오류', err)
    return { ok: false, code: 'internal', message: '알 수 없는 오류가 발생했습니다' }
  }
}

/** 1년. 다음에 와도 마지막에 보던 룸이 열린다. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365

async function setActiveWorkspace(workspaceId: string) {
  const store = await cookies()
  store.set(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  })
}

/**
 * 룸 전환.
 *
 * 돌려주는 pageId 로 클라이언트가 이동한다. 지금 보던 문서는 **다른 룸 소속**이라
 * 그 자리에 머무르면 사이드바와 본문이 어긋난다. 빈 룸이면 null 이고, 그때는 "/" 로 간다.
 */
export async function switchProjectRoom(
  workspaceId: string,
): Promise<ActionResult<{ pageId: string | null }>> {
  return run(async () => {
    const actor = await requireActor()
    // 내 룸이 아닌 id 로는 못 바꾼다 (쿠키를 심기 전에 막는다)
    await assertWorkspaceMember(actor.userId, workspaceId)

    await setActiveWorkspace(workspaceId)
    const pageId = await Workspaces.getFirstPageId(workspaceId)

    /**
     * 사이드바 트리와 라우트 데이터가 통째로 바뀐다.
     * staleTimes 로 켜 둔 클라이언트 캐시에 이전 룸이 남아 있으면 안 되므로
     * 여기서는 전체를 무효화하는 게 맞다.
     */
    revalidatePath('/', 'layout')
    return { pageId }
  })
}

/** 새 프로젝트 룸. 만든 사람이 owner 가 되고 "시작하기" 문서 하나가 함께 생긴다. */
export async function createProjectRoom(
  name: string,
): Promise<ActionResult<{ workspaceId: string; pageId: string }>> {
  return run(async () => {
    const actor = await requireActor()
    const { workspace, homePageId } = await Workspaces.createWorkspace(
      actor,
      name.trim() || '새 프로젝트 룸',
    )

    // 만들었으면 바로 그 룸으로 들어간다
    await setActiveWorkspace(workspace.id)
    revalidatePath('/', 'layout')
    return { workspaceId: workspace.id, pageId: homePageId }
  })
}

/** 룸 이름 변경. admin 이상만 통과한다 (core 의 assertWorkspaceAdmin). */
export async function renameProjectRoom(
  workspaceId: string,
  name: string,
): Promise<ActionResult<{ name: string }>> {
  return run(async () => {
    const actor = await requireActor()
    const row = await Workspaces.renameWorkspace(actor, workspaceId, name)

    // 이름은 사이드바(레이아웃)에 있다
    revalidatePath('/', 'layout')
    return { name: row.name }
  })
}
