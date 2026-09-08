-- 0001: drizzle 이 만들지 않는 것들
--   (1) 자기참조/순환 FK  (2) 한글 대응 검색 인덱스  (3) 검색벡터 트리거
-- 이 파일은 수동 관리한다. drizzle-kit generate 가 덮어쓰지 않는다.

-- ─────────────────────────────── (1) 누락된 FK

-- 자기참조: 부모 삭제 시 서브트리 함께 삭제
ALTER TABLE "pages"
  ADD CONSTRAINT "pages_parent_id_fk"
  FOREIGN KEY ("parent_id") REFERENCES "pages"("id") ON DELETE CASCADE;

-- pages <-> collections 는 상호 참조라 drizzle 이 순서를 못 잡는다
ALTER TABLE "pages"
  ADD CONSTRAINT "pages_collection_id_fk"
  FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE CASCADE;

ALTER TABLE "collections"
  ADD CONSTRAINT "collections_page_id_fk"
  FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE;

-- profiles 는 auth.users 의 미러다
ALTER TABLE "profiles"
  ADD CONSTRAINT "profiles_id_auth_users_fk"
  FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

-- ─────────────────────────────── (2) 검색 인덱스

-- 한국어는 tsvector 토크나이저가 없어서 부분일치가 안 된다.
-- 트라이그램을 주 수단으로 쓴다 ("회의" -> "회의록" 매칭됨).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "pages_title_trgm_idx"
  ON "pages" USING gin ("title" gin_trgm_ops);

CREATE INDEX "pages_plain_text_trgm_idx"
  ON "pages" USING gin ("plain_text" gin_trgm_ops);

-- tsvector 는 영문/혼용 단어 단위 매칭의 보조 수단
CREATE INDEX "pages_search_vector_idx"
  ON "pages" USING gin ("search_vector");

-- ─────────────────────────────── (3) 검색벡터 트리거

CREATE OR REPLACE FUNCTION pages_search_vector_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector :=
      setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A')
   || setweight(to_tsvector('simple', coalesce(NEW.plain_text, '')), 'B');
  RETURN NEW;
END;
$$;

CREATE TRIGGER pages_search_vector_trg
  BEFORE INSERT OR UPDATE OF title, plain_text ON "pages"
  FOR EACH ROW EXECUTE FUNCTION pages_search_vector_update();
