# SMTP 붙이기 (Gmail)

## 왜 필요한가

Supabase 내장 메일은 **시간당 2통**이고 **프로젝트 팀 멤버 주소로만** 발송된다.
즉 5인 팀에게 매직링크를 보내는 것 자체가 불가능하다. SMTP 는 선택이 아니라 필수다.

커스텀 SMTP 를 붙이면 상한이 시간당 30통으로 오르고 이후엔 조정 가능하다.

---

## 1. Google 앱 비밀번호 발급 (5분)

1. <https://myaccount.google.com/security> → **2단계 인증** 켜기 (안 켜면 앱 비밀번호 메뉴가 안 나온다)
2. <https://myaccount.google.com/apppasswords> → 이름 아무거나(`supabase-wiki`) → 생성
3. **16자리 비밀번호를 복사** — 다시 볼 수 없다. 공백은 빼고 붙여넣는다.

> Google Workspace 계정이면 관리자가 앱 비밀번호를 막아뒀을 수 있다.
> 그 경우 개인 Gmail 로 하거나 관리자에게 허용을 요청해야 한다.
>
> 앱 비밀번호는 **계정 비밀번호를 바꾸면 함께 무효화된다.** 나중에 로그인 메일이
> 갑자기 안 오면 여기부터 의심할 것.

## 2. Supabase 에 입력

대시보드 → **Authentication → Emails → SMTP Settings** → Enable custom SMTP

| 항목 | 값 |
|---|---|
| Host | `smtp.gmail.com` |
| Port | `587` |
| Username | `본인@gmail.com` (전체 주소) |
| Password | 위에서 받은 16자리 (공백 제거) |
| Sender email | **`본인@gmail.com` — Username 과 반드시 동일** |
| Sender name | `팀 위키` |

> ⚠️ **Sender email 이 Username 과 다르면 Gmail 이 거부한다.**
> 인증된 계정과 `MAIL FROM` 이 불일치하는 발송은 전부 반려된다.
> 여기서 대부분 막힌다.

## 3. Rate limit 올리기

**Authentication → Rate Limits** → "Rate limit for sending emails" 를 `30` 이상으로.
(커스텀 SMTP 를 켜면 기본 30/시간이 되지만 확인해 둔다.)

별개로 **동일 사용자의 재요청은 60초 쿨다운**이 있다. 이건 사용자별이라
다른 팀원에게는 영향이 없다.

## 4. Redirect URL 허용목록

**Authentication → URL Configuration**

| 항목 | 값 |
|---|---|
| Site URL | `http://localhost:3000` (배포 후엔 Vercel 주소로) |
| Redirect URLs | `http://localhost:3000/**`<br>`https://<배포주소>/**` |

`src/app/login/page.tsx` 가 만드는 `emailRedirectTo` 가 이 목록에 없으면
링크를 눌러도 되돌아오지 못한다.

## 5. 이메일 템플릿 (선택)

**Authentication → Emails → Templates → Magic Link** 에
`docs/email-templates/magic-link.html` 내용을 붙여넣는다.
(기본 영문 템플릿도 동작은 한다. 한글 안내가 필요하면 교체.)

## 6. 검증

```bash
npm run check:email -- 받을주소@example.com
```

실제 매직링크 발송 경로를 그대로 태워서 결과를 알려준다.
성공하면 메일함(및 **스팸함**)을 확인한다.

---

## 알아둘 제약

| 항목 | 내용 |
|---|---|
| 일일 한도 | 개인 Gmail 약 500통/일, Workspace 2,000통/일. 5인 팀에겐 넉넉하다 |
| **전달률** | 개인 Gmail 발신은 트랜잭션 메일용으로 설계된 게 아니라 **스팸함으로 갈 수 있다.** 첫 로그인 때 팀에 "스팸함 확인 후 '스팸 아님' 표시" 를 안내할 것 |
| 발신자 표시 | 받는 사람에게 개인 Gmail 주소로 보인다 |
| 나중에 도메인이 생기면 | Resend 로 5분이면 갈아탄다 (무료 3,000통/월, 도메인 3개). Host/Port/User/Pass 네 칸만 바꾸면 되고 앱 코드는 그대로다 |
