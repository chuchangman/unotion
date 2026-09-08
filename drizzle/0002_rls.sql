-- 0002: RLS — 2차 방어선
--
-- 보안 모델 정리:
--   * 앱의 모든 쓰기는 lib/core 를 통과하며 DATABASE_URL 직접 연결을 쓴다 (RLS 우회).
--     실제 권한 강제는 lib/core/permissions.ts 다.
--   * RLS 는 브라우저의 anon 키 접근과 Realtime 에 대한 방어선이다.
--     anon 키는 JS 번들에 노출되므로 이 정책이 없으면 누구나 전 문서를 읽을 수 있다.
--   * 그래서 정책은 SELECT 만 허용하고 INSERT/UPDATE/DELETE 정책은 아예 만들지 않는다.
--     (정책이 없으면 RLS 활성 테이블에서 해당 동작은 전부 거부된다)

-- ─────────────────────────────── 헬퍼

CREATE OR REPLACE FUNCTION public.is_workspace_member(ws_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_members
     WHERE workspace_id = ws_id AND user_id = auth.uid()
  );
$$;

-- 페이지 자신 또는 조상에 명시적 권한이 있거나, 워크스페이스 멤버면 읽을 수 있다.
-- lib/core/permissions.ts 의 resolvePageAccess 와 같은 규칙이다 (게스트 처리 포함).
CREATE OR REPLACE FUNCTION public.can_read_page(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public AS $$
DECLARE
  v_ws uuid;
  v_path text;
  v_role text;
BEGIN
  SELECT workspace_id, path INTO v_ws, v_path FROM pages WHERE id = p_id;
  IF v_ws IS NULL THEN RETURN false; END IF;

  -- 명시적 권한 (자신 또는 조상)
  IF EXISTS (
    SELECT 1 FROM page_permissions pp
     WHERE pp.user_id = auth.uid()
       AND (pp.page_id = p_id
            OR pp.page_id::text = ANY (string_to_array(trim(both '/' from v_path), '/')))
  ) THEN
    RETURN true;
  END IF;

  SELECT role INTO v_role FROM workspace_members
   WHERE workspace_id = v_ws AND user_id = auth.uid();

  -- 게스트는 명시적으로 공유된 페이지만 본다
  RETURN v_role IS NOT NULL AND v_role <> 'guest';
END;
$$;

-- ─────────────────────────────── RLS 활성화

ALTER TABLE "profiles"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspaces"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invites"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pages"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "collections"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "collection_views"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "page_relations"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "page_links"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "page_permissions"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public_shares"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "comments"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "page_versions"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_tokens"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "page_chunks"       ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────── SELECT 정책 (읽기만 허용)

CREATE POLICY "read own profile and co-members" ON "profiles"
  FOR SELECT TO authenticated USING (
    id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM workspace_members mine
      JOIN workspace_members theirs ON theirs.workspace_id = mine.workspace_id
      WHERE mine.user_id = auth.uid() AND theirs.user_id = profiles.id
    )
  );

CREATE POLICY "read my workspaces" ON "workspaces"
  FOR SELECT TO authenticated USING (public.is_workspace_member(id));

CREATE POLICY "read members of my workspaces" ON "workspace_members"
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));

CREATE POLICY "read pages i can read" ON "pages"
  FOR SELECT TO authenticated USING (public.can_read_page(id));

CREATE POLICY "read collections in my workspaces" ON "collections"
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));

CREATE POLICY "read views of readable collections" ON "collection_views"
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM collections c
             WHERE c.id = collection_views.collection_id
               AND public.is_workspace_member(c.workspace_id))
  );

CREATE POLICY "read relations of readable pages" ON "page_relations"
  FOR SELECT TO authenticated USING (public.can_read_page(from_page_id));

CREATE POLICY "read links of readable pages" ON "page_links"
  FOR SELECT TO authenticated USING (public.can_read_page(from_page_id));

CREATE POLICY "read permissions of readable pages" ON "page_permissions"
  FOR SELECT TO authenticated USING (public.can_read_page(page_id));

CREATE POLICY "read comments on readable pages" ON "comments"
  FOR SELECT TO authenticated USING (public.can_read_page(page_id));

CREATE POLICY "read versions of readable pages" ON "page_versions"
  FOR SELECT TO authenticated USING (public.can_read_page(page_id));

CREATE POLICY "read my notifications" ON "notifications"
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "read my own tokens" ON "access_tokens"
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "read audit of my workspaces" ON "audit_log"
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));

-- 공개 공유는 익명에게도 열린다 (Phase 4)
CREATE POLICY "anyone reads public share rows" ON "public_shares"
  FOR SELECT TO anon, authenticated USING (true);

-- invites / page_chunks 는 정책 없음 = 클라이언트에서 접근 불가 (서버 전용)

-- ─────────────────────────────── Realtime 브로드캐스트 (Yjs 동기화 채널)
--
-- ⚠️ 중요: anon 키는 JS 번들에 노출된다. 퍼블릭 채널을 쓰면 누구나 페이지
-- 채널에 붙어 편집 내용을 읽거나 주입할 수 있다. 반드시 private 채널 +
-- realtime.messages RLS 를 써야 한다. 채널 topic 은 pageId 다.

CREATE POLICY "join page channels i can read" ON "realtime"."messages"
  FOR SELECT TO authenticated USING (
    public.can_read_page((realtime.topic())::uuid)
  );

CREATE POLICY "send to page channels i can read" ON "realtime"."messages"
  FOR INSERT TO authenticated WITH CHECK (
    public.can_read_page((realtime.topic())::uuid)
  );
