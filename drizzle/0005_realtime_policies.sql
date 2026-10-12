-- 0005: Realtime 채널 권한 — 보내기는 "편집할 수 있는 사람" 만. 워크스페이스 신호 채널 추가.
--
-- ★ 왜 바꾸나
--   0002 의 전송(INSERT) 정책이 can_read_page 였다. 읽기·코멘트 권한만 있는 사람도 페이지
--   채널에 y-update 를 보낼 수 있었고, 받는 편집자의 에디터가 그걸 적용한 뒤 다음 저장 때
--   DB 에 남겼다 — 저장 경로(lib/core/pages.ts 의 assertCanEdit)를 비껴가는 쓰기였다.
--   이제 읽기 전용은 **받기만** 한다. 프로바이더도 읽기 전용이면 아무것도 보내지 않고,
--   빠진 조각이 생기면 서버에서 당겨 온다 (lib/realtime/supabase-yjs-provider.ts).
--
-- ★ 토픽 두 종류
--   <pageId>   본문 동기화
--   ws:<wsId>  "무엇이 바뀌었다" 신호. 받은 쪽이 사이드바·표·코멘트를 다시 읽는다
--              (components/live/WorkspaceLive.tsx). 내용은 싣지 않는다.
--   uuid 가 아닌 토픽을 (realtime.topic())::uuid 로 캐스팅하면 정책 평가가 오류로 끝나므로
--   realtime_topic_uuid() 로 안전하게 푼다 (uuid 가 아니면 NULL → 거부).

CREATE OR REPLACE FUNCTION public.realtime_topic_uuid(topic text)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN topic ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN topic::uuid
         END;
$$;

-- lib/core/permissions.ts 의 resolvePageAccess 와 같은 규칙이다.
--   1) 페이지 자신 → 부모 → 조부모 … 순으로 가장 가까운 명시 권한이 이긴다
--   2) 없으면 워크스페이스 역할 기본값: owner/admin/member = 편집 가능, guest = 없음
-- 명시 권한이 역할보다 낮을 수도 있다 (멤버에게 read 를 걸면 그 문서는 읽기 전용).
CREATE OR REPLACE FUNCTION public.can_edit_page(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public AS $$
DECLARE
  v_ws    uuid;
  v_path  text;
  v_chain text[];
  v_level text;
  v_role  text;
BEGIN
  IF p_id IS NULL THEN RETURN false; END IF;

  SELECT workspace_id, path INTO v_ws, v_path FROM pages WHERE id = p_id;
  IF v_ws IS NULL THEN RETURN false; END IF;

  -- path 는 '/루트/…/부모/' — 뒤에서부터(가까운 조상부터) 세운다
  SELECT array_agg(x ORDER BY ord DESC) INTO v_chain
    FROM unnest(string_to_array(trim(both '/' from v_path), '/')) WITH ORDINALITY AS t(x, ord)
   WHERE x <> '';
  v_chain := array_prepend(p_id::text, coalesce(v_chain, '{}'::text[]));

  SELECT pp.level INTO v_level
    FROM page_permissions pp
   WHERE pp.user_id = auth.uid()
     AND pp.page_id::text = ANY (v_chain)
   ORDER BY array_position(v_chain, pp.page_id::text)
   LIMIT 1;
  IF v_level IS NOT NULL THEN
    RETURN v_level IN ('edit', 'full');
  END IF;

  SELECT role INTO v_role FROM workspace_members
   WHERE workspace_id = v_ws AND user_id = auth.uid();
  -- 멤버가 아니면 v_role 이 NULL 이고, NULL IN (...) 은 false 가 아니라 NULL 이다
  RETURN coalesce(v_role IN ('owner', 'admin', 'member'), false);
END;
$$;

-- 워크스페이스 신호 채널은 게스트를 뺀 멤버만. 게스트는 공유받은 문서만 보는 게 규칙이라
-- "어느 페이지가 바뀌었다" 는 신호도 받지 않는다.
CREATE OR REPLACE FUNCTION public.is_workspace_insider(ws_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public AS $$
  SELECT ws_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM workspace_members
     WHERE workspace_id = ws_id AND user_id = auth.uid() AND role <> 'guest'
  );
$$;

DROP POLICY IF EXISTS "join page channels i can read" ON "realtime"."messages";
DROP POLICY IF EXISTS "send to page channels i can read" ON "realtime"."messages";

CREATE POLICY "join page or workspace channels" ON "realtime"."messages"
  FOR SELECT TO authenticated USING (
    CASE
      WHEN realtime.topic() LIKE 'ws:%'
        THEN public.is_workspace_insider(public.realtime_topic_uuid(substring(realtime.topic() FROM 4)))
      ELSE public.can_read_page(public.realtime_topic_uuid(realtime.topic()))
    END
  );

CREATE POLICY "send to page or workspace channels" ON "realtime"."messages"
  FOR INSERT TO authenticated WITH CHECK (
    CASE
      WHEN realtime.topic() LIKE 'ws:%'
        THEN public.is_workspace_insider(public.realtime_topic_uuid(substring(realtime.topic() FROM 4)))
      ELSE public.can_edit_page(public.realtime_topic_uuid(realtime.topic()))
    END
  );
