'use server'

/**
 * 프로젝트 룸 웹 어댑터. 로직은 없다 — lib/core/workspaces 를 부르고 직렬화만 한다.
 *
 * ★ 이 파일만 활성 룸 쿠키를 쓴다.
 *   쿠키는 서버 액션이나 라우트 핸들러에서만 설정할 수 있어서, 렌더 경로
 *   (getSessionContext)는 읽기만 하고 바꾸는 건 전부 여기를 거친다.
 *
 * 룸을 바꾼 뒤의 이동은 클라이언트가 한다 — 갈 곳(pageId)을 돌려준다.
 * (redirect 를 써도 이제 lib/action.ts 의 run() 이 삼키지 않지만, 클라이언트가
 *  이동 전에 할 일(드롭다운 닫기 등)이 있어서 지금 방식이 낫다.)
 */
import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor, ACTIVE_WORKSPACE_COOKIE } from '@/lib/auth'
import * as Workspaces from '@/lib/core/workspaces'
import { assertWorkspaceMember } from '@/lib/core/permissions'
import { run, type ActionResult } from '@/lib/action'
import { Id, parse } from '@/lib/validation'

/** 1년. 다음에 와도 마지막에 보던 룸이 열린다. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/** 룸 이름 규칙(빈 이름·60자)은 core 가 본다. 여기서는 문자열인지만 */
const RoomName = z.string().max(200, '룸 이름이 너무 깁니다')

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
  return run('workspaces', async () => {
    const id = parse(Id, workspaceId)
    const actor = await requireActor()
    // 내 룸이 아닌 id 로는 못 바꾼다 (쿠키를 심기 전에 막는다)
    await assertWorkspaceMember(actor.userId, id)

    await setActiveWorkspace(id)
    const pageId = await Workspaces.getFirstPageId(actor, id)

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
  return run('workspaces', async () => {
    const valid = parse(RoomName, name)
    const actor = await requireActor()
    const { workspace, homePageId } = await Workspaces.createWorkspace(
      actor,
      valid.trim() || '새 프로젝트 룸',
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
  return run('workspaces', async () => {
    const id = parse(Id, workspaceId)
    const actor = await requireActor()
    const row = await Workspaces.renameWorkspace(actor, id, parse(RoomName, name))

    // 이름은 사이드바(레이아웃)에 있다
    revalidatePath('/', 'layout')
    return { name: row.name }
  })
}

/**
 * 멤버 내보내기. admin 이상이 **자기보다 낮은 권한만** 내보낼 수 있다
 * (판정은 core 의 removeMember 가 한다).
 */
export async function removeProjectMember(
  workspaceId: string,
  userId: string,
): Promise<ActionResult<null>> {
  return run('workspaces', async () => {
    const id = parse(Id, workspaceId)
    const user = parse(Id, userId)
    const actor = await requireActor()
    await Workspaces.removeMember(actor, id, user)

    /**
     * 멤버 목록은 설정 화면에 있고, 사이드바의 룸 목록도 멤버 수로 정렬된다.
     * 레이아웃까지 무효화해야 둘 다 맞는다.
     */
    revalidatePath('/', 'layout')
    return null
  })
}
