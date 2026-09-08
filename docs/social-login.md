# Google 로그인 설정

코드는 이미 붙어 있다. 아래는 대시보드에서 해야 하는 일이라 직접 하셔야 한다.

## 1. Google Cloud Console (5분)

<https://console.cloud.google.com/apis/credentials>

1. 프로젝트 없으면 생성 → **사용자 인증 정보 만들기 → OAuth 클라이언트 ID**
2. 동의 화면을 아직 안 만들었으면 먼저 구성한다
   - User Type: **내부(Internal)** ← Workspace 조직이면 이게 가장 간단하다.
     외부(External)로 만들면 테스트 사용자를 일일이 등록해야 한다.
   - 앱 이름 `팀 위키`, 지원 이메일 본인
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

## 매직링크는 왜 남겼나

Google 계정이 없는 외부 인원(협력사 등)을 게스트로 초대할 때 필요하다.
로그인 화면 아래 "이메일 링크로 로그인" 에 접혀 있다.

## 초대와 이메일 일치

초대를 수락할 때 **초대받은 이메일과 로그인한 계정의 이메일이 같아야 한다.**
링크가 유출돼도 다른 계정으로는 들어올 수 없게 하려는 것이다.

즉 Google 로그인을 쓰는 팀원은 **그 Google 계정 이메일로 초대**해야 한다.
회사 Gmail 과 개인 Gmail 을 섞으면 여기서 막힌다.
