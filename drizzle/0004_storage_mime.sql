-- 0004: 업로드 MIME 목록 정정
--
-- 왜:
--   0003 의 목록은 표준(IANA) 이름으로 적혀 있는데, 브라우저는 **OS 가 알려주는**
--   이름을 보낸다. 윈도우 크롬·엣지는 MIME 을 레지스트리에서 읽으므로
--
--     .zip → application/x-zip-compressed   (표준은 application/zip)
--     .csv → application/vnd.ms-excel       (엑셀이 깔려 있으면)
--     .md  → 빈 값                           (레지스트리에 등록이 없다)
--
--   로 와서 415 로 거부됐다. 목록에 zip/csv/markdown 이 **적혀 있는데도**
--   윈도우에서는 셋 다 올라가지 않았다 (zip 이 실제로 이렇게 실패했다).
--
-- 어떻게:
--   클라이언트가 확장자로 MIME 을 정규화해서 올린다 (src/lib/upload.ts).
--   아래 목록은 그 표와 1:1 이다. 한쪽을 고치면 다른 쪽도 같이 고쳐야 한다.
--
-- application/octet-stream 을 넣은 이유:
--   표에 없는 확장자(.hwp, .psd, .ai ...)도 첨부는 돼야 한다. octet-stream 은
--   브라우저가 렌더하지 않고 내려받으므로 공개 버킷에서도 안전하다.
--   반대로 text/html 과 image/svg+xml 은 계속 뺀다 — 스크립트를 품고 실행된다.
--   (그래서 이 목록의 역할은 "무엇을 저장하냐"가 아니라
--    "무엇을 **브라우저가 렌더하는 타입으로** 서빙하냐" 다.)

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  -- 이미지 (svg 는 제외 — 위 메모 참고)
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',

  -- 문서
  'application/pdf',
  'text/plain', 'text/csv', 'text/markdown', 'application/json',

  -- 오피스
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',

  -- 압축
  'application/zip', 'application/gzip', 'application/x-tar',
  'application/x-7z-compressed',

  -- 미디어
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/wav', 'audio/mp4',

  -- 그 외 전부 (내려받기 전용)
  'application/octet-stream'
]
WHERE id = 'page-files';
