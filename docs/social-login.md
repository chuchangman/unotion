# Google 로그인 설정

코드는 이미 붙어 있다. 아래는 대시보드에서 해야 하는 일이라 직접 하셔야 한다.

## 1. Google Cloud Console (5분)

<https://console.cloud.google.com/apis/credentials>

1. 프로젝트 없으면 생성 → **사용자 인증 정보 만들기 → OAuth 클라이언트 ID**
2. 동의 화면(최신 콘솔에서는 **Google Auth Platform → Audience**)을 구성한다
   - **User Type: 외부(External)** 를 선택한다
   - 앱 이름 `팀 위키`, 지원 이메일 본인
   - 만든 뒤 **앱 게시(Publish app)** 를 눌러 상태를 **In production** 으로 바꾼다

   > ⚠️ **내부(Internal)를 고르면 안 된다.** 그 Google Workspace 조직 계정만
   > 로그인할 수 있어서, 개인 Gmail 로 시도하면 이렇게 막힌다:
   >
   > ```
   > 액세스 차단됨: unotion은(는) 조직 내에서만 사용할 수 있습니다
   > 403 오류: org_internal
   > ```
   >
   > 팀원이 개인 Gmail 을 쓰거나 조직 밖 인원이 하나라도 있으면 External 이어야 한다.

   > **External 인데 검수가 필요할까?** 필요 없다.
   > 우리는 `email` 과 `profile` 만 요청하는데 이건 **비민감(non-sensitive) 스코프**라
   > 게시에 Google 검수가 붙지 않는다. 민감/제한 스코프를 쓸 때만 심사를 받는다.
   >
   > 게시하지 않고 **Testing** 상태로 두려면 팀원을 **테스트 사용자**로
   > 일일이 등록해야 한다 (최대 100명). 5인 팀이면 그냥 게시하는 게 편하다.
3. 애플리케이션 유형: **웹 애플리케이션**
4. **승인된 리디렉션 URI** 에 아래를 정확히 입력한다 (앱 주소가 아니라 Supabase 주소다)

```
https://<프로젝트ref>.supabase.co/auth/v1/callback
```

> 프로젝트 ref 는 Supabase 대시보드 URL 이나 `NEXT_PUBLIC_SUPABASE_URL` 에서 확인한다.
> **여기에 우리 앱 주소(unotion.vercel.app)를 넣으면 안 된다.** Google → Supabase →
> 우리 앱 순서로 돌아오기 때문이다.

5. 생성 후 **클라이언트 ID** 와 **클라이언트 보안 비밀** 을 복사

## 2. Supabase

**Authentication → Providers → Google** → 활성화 → 위 두 값 붙여넣기 → 저장

## 3. Redirect URL 확인

**Authentication → URL Configuration → Redirect URLs** 에 아래가 있어야 한다:

```
https://unotion.vercel.app/**
http://localhost:3000/**
```

## 4. 확인

<https://unotion.vercel.app/login> → **Google 계정으로 계속**

---

## 막혔을 때

| 증상 | 원인 | 해결 |
|---|---|---|
| `403 org_internal` — "조직 내에서만 사용할 수 있습니다" | 동의 화면이 **내부(Internal)** | External 로 바꾸고 게시 (위 2번) |
| `400 redirect_uri_mismatch` | Google 의 승인된 리디렉션 URI 가 틀림 | 앱 주소가 아니라 `https://<ref>.supabase.co/auth/v1/callback` |
| Google 로그인 후 localhost 로 감 | Supabase Redirect URLs 에 배포 주소가 없어 Site URL 로 폴백 | 위 3번 확인 |
| `invalid_client` | 클라이언트 보안 비밀이 틀림 | Supabase 에 다시 붙여넣기 |

진단은 아래 한 줄로도 된다 — Google 로 정상 이동하면 Supabase 설정은 맞는 것이다:

```bash
curl -sD - -o /dev/null   "https://<ref>.supabase.co/auth/v1/authorize?provider=google&redirect_to=https%3A%2F%2Funotion.vercel.app%2Fauth%2Fcallback"   | grep -i ^location
```

## 매직링크는 왜 남겼나

Google 계정이 없는 외부 인원(협력사 등)을 게스트로 초대할 때 필요하다.
로그인 화면 아래 "이메일 링크로 로그인" 에 접혀 있다.

## 초대와 이메일 일치

초대를 수락할 때 **초대받은 이메일과 로그인한 계정의 이메일이 같아야 한다.**
링크가 유출돼도 다른 계정으로는 들어올 수 없게 하려는 것이다.

즉 Google 로그인을 쓰는 팀원은 **그 Google 계정 이메일로 초대**해야 한다.
회사 Gmail 과 개인 Gmail 을 섞으면 여기서 막힌다.
