/**
 * 업로드 파일의 MIME 을 **확장자로** 정한다.
 *
 * ★ 브라우저가 주는 `file.type` 을 믿으면 안 된다.
 *   윈도우 크롬·엣지는 MIME 을 **레지스트리에서** 읽어오기 때문에 같은 파일이
 *   OS 마다 다른 이름으로 온다 (개발 PC 에서 실측한 값):
 *
 *     .zip → application/x-zip-compressed   (표준은 application/zip)
 *     .csv → application/vnd.ms-excel       (엑셀이 깔려 있으면)
 *     .md  → 빈 문자열                       (레지스트리에 등록 자체가 없다)
 *
 *   버킷의 allowed_mime_types 는 표준 이름으로 적혀 있어서 이대로 올리면 415 로
 *   거부된다. zip 업로드가 실제로 이렇게 실패했다.
 *
 * ★ 이 표를 고치면 drizzle/0004_storage_mime.sql 의 목록도 같이 고쳐야 한다.
 *   실제 강제선은 버킷 쪽이다 (우리 클라이언트를 거치지 않는 업로드도 있으므로).
 */

/** 버킷의 file_size_limit(0003) 과 같은 값이어야 한다 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** 표에 없는 확장자는 이걸로 올린다 — 브라우저가 렌더하지 않고 내려받는다 */
export const FALLBACK_MIME = 'application/octet-stream'

export const EXTENSION_MIME: Record<string, string> = {
  // 이미지 (svg 는 BLOCKED_EXTENSIONS 참고)
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',

  // 문서
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',

  // 오피스 — 팀 위키에 실제로 붙는 것들
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

  // 압축
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',

  // 미디어
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
}

/**
 * 브라우저에서 **렌더되는** 형식은 막는다.
 *
 * 버킷이 공개라 URL 만 알면 누구나 연다. HTML·SVG 는 스크립트를 품을 수 있고
 * 스토리지 오리진에서 그대로 실행된다. 앱과 다른 오리진이라 앱 쿠키까지 새지는
 * 않지만, 우리 파일처럼 보이는 피싱 페이지를 올릴 수 있다.
 *
 * 표에 없는 확장자를 octet-stream 으로 넘기는 것과는 다르다 — 그건 내려받기만 된다.
 */
const BLOCKED_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'svg', 'js', 'mjs'])

/**
 * `보고서.tar.gz` → `gz`, `README` → `''`.
 *
 * 점이 없으면 빈 문자열이다 — `split('.').pop()` 은 이 경우 **파일명 전체**를
 * 돌려주므로 확장자로 쓰면 `<uuid>.README` 같은 경로가 만들어진다.
 */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return ''
  return filename.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * 올려도 되는 파일인지 확인하고, 저장할 확장자와 MIME 을 정한다.
 * 거부는 예외로 알린다 — 메시지가 그대로 사용자에게 보인다.
 */
export function resolveUpload(file: File): { ext: string; contentType: string } {
  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1)
    throw new Error(`파일이 너무 큽니다 (최대 10MB, 지금 ${mb}MB)`)
  }

  const ext = extensionOf(file.name)

  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new Error(`.${ext} 파일은 올릴 수 없습니다 — 브라우저에서 실행될 수 있는 형식입니다`)
  }

  return { ext, contentType: EXTENSION_MIME[ext] ?? FALLBACK_MIME }
}
