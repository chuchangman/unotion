-- 0003: 본문에 넣는 이미지 / 파일 저장소
--
-- 왜 공개(public) 버킷인가:
--   업로드한 파일의 URL 은 본문 ydoc 안에 그대로 박힌다. 비공개 버킷의 서명 URL 은
--   만료되므로 시간이 지나면 문서마다 깨진 이미지가 남는다. 그걸 피하려면 렌더링 때마다
--   URL 을 재발급하는 프록시 계층이 필요한데, 5인 팀 위키에 그건 과하다.
--   대신 경로에 UUID 를 넣어 추측할 수 없게 하고, **업로드**는 아래 정책으로 잠근다.
--
--   트레이드오프: URL 을 아는 사람은 로그인 없이도 그 파일을 볼 수 있다.
--   기밀 파일을 붙이는 용도로는 쓰지 말 것.
--
-- 경로 규칙: <pageId>/<uuid>.<ext>
--   첫 세그먼트가 페이지 id 라서, 업로드 정책이 그 페이지 권한을 그대로 물어볼 수 있다.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'page-files',
  'page-files',
  true,
  10485760, -- 10MB
  ARRAY[
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
    'application/pdf',
    'text/plain', 'text/csv', 'text/markdown',
    'application/zip',
    'video/mp4', 'video/webm',
    'audio/mpeg', 'audio/wav'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- image/svg+xml 은 일부러 뺐다. SVG 는 스크립트를 품을 수 있고 이 버킷은 공개다.
-- (스토리지는 앱과 다른 오리진이라 앱 쿠키까지 새지는 않지만, 굳이 열어둘 이유가 없다.)
-- 팀에서 SVG 가 꼭 필요하면 위 배열에 추가하면 된다.

-- ─────────────────────────────── storage.objects 정책

DROP POLICY IF EXISTS "page-files: read" ON storage.objects;
DROP POLICY IF EXISTS "page-files: upload" ON storage.objects;
DROP POLICY IF EXISTS "page-files: delete own" ON storage.objects;

-- 읽기는 공개다 (버킷이 public 이므로 정책도 그에 맞춘다)
CREATE POLICY "page-files: read" ON storage.objects
  FOR SELECT TO public USING (bucket_id = 'page-files');

-- 올리는 건 **그 페이지를 읽을 수 있는 로그인 사용자**만.
-- can_read_page 는 0002 에서 만든 헬퍼로, lib/core/permissions.ts 와 같은 규칙이다.
CREATE POLICY "page-files: upload" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'page-files'
    AND public.can_read_page(((storage.foldername(name))[1])::uuid)
  );

-- 지우는 건 올린 사람만
CREATE POLICY "page-files: delete own" ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'page-files' AND owner = auth.uid()
  );
