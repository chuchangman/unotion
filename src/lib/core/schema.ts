/**
 * Drizzle schema — 단일 진실의 원천.
 *
 * 설계 원칙 (변경 시 반드시 재검토):
 *  1) 노션처럼 "모든 것은 페이지다". DB의 행도 pages 행이다.
 *  2) ydoc(BYTEA)이 본문의 진실이고 contentJson/plainText는 파생 스냅샷이다.
 *  3) sortKey는 정수가 아니라 fractional index다 (형제 재번호매김 방지).
 *  4) path는 머티리얼라이즈드 패스다. 권한 상속을 LIKE '/a/b/%' 로 푼다.
 */
import { sql } from 'drizzle-orm'
import {
  pgTable, uuid, text, jsonb, boolean, timestamp, integer,
  customType, index, uniqueIndex, primaryKey,
} from 'drizzle-orm/pg-core'

/** Yjs 문서 상태 (바이너리) */
const bytea = customType<{ data: Buffer }>({
  dataType: () => 'bytea',
})

/** 전문검색 벡터 — 트리거로 채운다 */
const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
})

// ─────────────────────────────────────────── 사용자 / 워크스페이스

/** auth.users 미러. Supabase 표준 패턴. */
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(), // = auth.users.id
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id').notNull().references(() => profiles.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** owner > admin > member > guest */
export const workspaceMembers = pgTable('workspace_members', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })])

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role').notNull().default('member'),
  token: text('token').notNull().unique(),
  invitedBy: uuid('invited_by').notNull().references(() => profiles.id),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

// ─────────────────────────────────────────── 페이지 (핵심)

export const pages = pgTable('pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),

  parentId: uuid('parent_id'), // self-ref, FK는 SQL 마이그레이션에서 추가
  /** 머티리얼라이즈드 패스: '/<rootId>/<childId>/' — 권한 상속과 서브트리 조회용 */
  path: text('path').notNull().default('/'),
  /** 형제 순서. fractional index 문자열 ('a0', 'a0V', 'a1'...) */
  sortKey: text('sort_key').notNull(),

  /** DB(컬렉션)의 행이면 소속 컬렉션 */
  collectionId: uuid('collection_id'),

  title: text('title').notNull().default(''),
  icon: jsonb('icon').$type<{ type: 'emoji' | 'url'; value: string } | null>(),
  cover: jsonb('cover').$type<{ type: 'url'; value: string } | null>(),

  /** 컬렉션 행일 때의 속성값 { [propId]: unknown } */
  properties: jsonb('properties').notNull().default(sql`'{}'::jsonb`),

  /** ★ 본문의 진실. Yjs 문서 상태 */
  ydoc: bytea('ydoc'),
  /** 파생 스냅샷 — 렌더/내보내기/MCP 읽기용 (BlockNote 문서 배열) */
  contentJson: jsonb('content_json'),
  /** 파생 평문 — 검색/RAG용. 트리거가 searchVector를 만든다 */
  plainText: text('plain_text').notNull().default(''),
  searchVector: tsvector('search_vector'),

  isTemplate: boolean('is_template').notNull().default(false),
  isTrashed: boolean('is_trashed').notNull().default(false),
  trashedAt: timestamp('trashed_at', { withTimezone: true }),

  createdBy: uuid('created_by').references(() => profiles.id),
  lastEditedBy: uuid('last_edited_by').references(() => profiles.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

  /** 노션 1회성 마이그레이션 흔적. 링크 해석 + 출처 추적용 */
  notionId: text('notion_id'),
}, (t) => [
  index('pages_ws_parent_idx').on(t.workspaceId, t.parentId),
  index('pages_path_idx').on(t.path),
  index('pages_collection_idx').on(t.collectionId),
  uniqueIndex('pages_ws_notion_idx').on(t.workspaceId, t.notionId),
])

// ─────────────────────────────────────────── 데이터베이스 (컬렉션)

export type PropertyType =
  | 'title' | 'text' | 'number' | 'select' | 'multi_select' | 'status'
  | 'date' | 'person' | 'files' | 'checkbox' | 'url' | 'email' | 'phone'
  | 'created_time' | 'created_by' | 'last_edited_time' | 'last_edited_by'
  | 'relation' | 'rollup' | 'formula'

export type PropertyDef = {
  id: string
  name: string
  type: PropertyType
  config?: Record<string, unknown>
}

export const collections = pgTable('collections', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  /** 이 컬렉션을 담고 있는 페이지 */
  pageId: uuid('page_id').notNull(),
  name: text('name').notNull().default(''),
  schema: jsonb('schema').$type<PropertyDef[]>().notNull().default(sql`'[]'::jsonb`),
  notionDatabaseId: text('notion_database_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type ViewType = 'table' | 'board' | 'calendar' | 'gallery' | 'list'

export const collectionViews = pgTable('collection_views', {
  id: uuid('id').primaryKey().defaultRandom(),
  collectionId: uuid('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
  type: text('type').$type<ViewType>().notNull().default('table'),
  name: text('name').notNull().default('Table'),
  sortKey: text('sort_key').notNull(),
  /** { filters, sorts, groupBy, visibleProps, colWidths } */
  config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
})

/** relation / rollup 속성의 실제 간선 */
export const pageRelations = pgTable('page_relations', {
  fromPageId: uuid('from_page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  propertyId: text('property_id').notNull(),
  toPageId: uuid('to_page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
}, (t) => [
  primaryKey({ columns: [t.fromPageId, t.propertyId, t.toPageId] }),
  index('page_relations_to_idx').on(t.toPageId),
])

/** 백링크. 본문 저장 시 파생 재계산 */
export const pageLinks = pgTable('page_links', {
  fromPageId: uuid('from_page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  toPageId: uuid('to_page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
}, (t) => [
  primaryKey({ columns: [t.fromPageId, t.toPageId] }),
  index('page_links_to_idx').on(t.toPageId),
])

// ─────────────────────────────────────────── 권한 / 공유

export type PermissionLevel = 'full' | 'edit' | 'comment' | 'read'

/** 페이지에 걸린 명시적 권한. 없으면 워크스페이스 멤버십 + 상위 페이지 상속을 따른다. */
export const pagePermissions = pgTable('page_permissions', {
  pageId: uuid('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  level: text('level').$type<PermissionLevel>().notNull(),
}, (t) => [primaryKey({ columns: [t.pageId, t.userId] })])

export const publicShares = pgTable('public_shares', {
  pageId: uuid('page_id').primaryKey().references(() => pages.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull().unique(),
  allowIndexing: boolean('allow_indexing').notNull().default(false),
  createdBy: uuid('created_by').notNull().references(() => profiles.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ─────────────────────────────────────────── 협업 부속

export const comments = pgTable('comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  pageId: uuid('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  /** 인라인 코멘트가 걸린 블록. 페이지 코멘트면 null */
  blockId: text('block_id'),
  /** 스레드 루트의 id. 루트 자신은 자기 id */
  threadId: uuid('thread_id').notNull(),
  authorId: uuid('author_id').notNull().references(() => profiles.id),
  body: text('body').notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: uuid('resolved_by').references(() => profiles.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('comments_page_thread_idx').on(t.pageId, t.threadId)])

export const pageVersions = pgTable('page_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  pageId: uuid('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default(''),
  contentJson: jsonb('content_json'),
  authorId: uuid('author_id').references(() => profiles.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('page_versions_page_idx').on(t.pageId, t.createdAt)])

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // mention | comment | invite
  pageId: uuid('page_id').references(() => pages.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').references(() => profiles.id),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('notifications_user_idx').on(t.userId, t.readAt)])

// ─────────────────────────────────────────── MCP / 감사

/**
 * MCP용 개인 액세스 토큰. 평문은 발급 시 한 번만 보여주고 해시만 저장한다.
 */
export const accessTokens = pgTable('access_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** 모든 쓰기의 출처를 남긴다. MCP 경유 변경을 구분할 수 있어야 한다. */
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').references(() => profiles.id),
  /** 'web' | 'mcp' | 'api' | 'migration' */
  source: text('source').notNull().default('web'),
  action: text('action').notNull(), // page.create | page.update | ...
  targetId: uuid('target_id'),
  meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('audit_log_ws_idx').on(t.workspaceId, t.createdAt)])

/** Phase 6 RAG용 */
export const pageChunks = pgTable('page_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  pageId: uuid('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  chunkIndex: integer('chunk_index').notNull(),
  text: text('text').notNull(),
}, (t) => [uniqueIndex('page_chunks_unique').on(t.pageId, t.chunkIndex)])
