# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "fastapi>=0.115",
#   "uvicorn>=0.32",
#   "python-multipart>=0.0.12",
#   "faster-whisper>=1.1.0",
# ]
# ///
"""
내 PC에서 도는 Whisper 서버. **가입도 키도 돈도 필요 없다.**

    uv run scripts/whisper-server.py

그리고 .env.local 에:

    TRANSCRIBE_BASE_URL=http://127.0.0.1:8000/v1
    TRANSCRIBE_MODEL=large-v3-turbo

─────────────────────────────────────────────────────────────────────────────
왜 이게 필요한가

Whisper 는 오픈소스(MIT)고 모델 가중치도 공개돼 있다. 하지만 "오픈소스" 는
**내 컴퓨터에서 공짜로 돌릴 수 있다**는 뜻이지, 어딘가에 서버가 이미 떠 있다는
뜻이 아니다. 뭔가는 그 모델을 실행해야 한다 — 그게 이 파일이다.

앱(src/lib/core/transcribe.ts)은 OpenAI 전사 규격으로만 말한다. 그래서 여기서
그 엔드포인트 **하나**만 흉내 내면 앱 코드는 한 줄도 안 바뀐다. OpenAI 로 갈지,
Groq 으로 갈지, 이 서버로 갈지가 전부 환경변수 문제가 된다.

─────────────────────────────────────────────────────────────────────────────
알아둘 것

* 첫 실행은 모델을 내려받는다 (large-v3-turbo 기준 약 1.6GB, 한 번만).
  빨리 확인만 하려면:  uv run scripts/whisper-server.py --model small

* GPU 를 못 잡으면 **CPU 로 알아서 떨어진다.** 느릴 뿐 동작은 한다.
  NVIDIA GPU 를 쓰려면 cuDNN/cuBLAS 가 있어야 한다:
      uv run --with nvidia-cublas-cu12 --with nvidia-cudnn-cu12 scripts/whisper-server.py

* 127.0.0.1 로 띄우므로 회의 내용이 이 PC 밖으로 **한 바이트도 안 나간다.**
  그래서 앱의 외부 전송 차단(TRANSCRIBE_ALLOW_EXTERNAL)에도 안 걸린다.

* 개발·소규모 팀용이다. 인증이 없으므로 공개망에 열지 말 것.
"""

from __future__ import annotations

import argparse
import io
import sys
import time

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

"""
★ 출력 설정을 먼저 잡는다. 둘 다 실제로 이 스크립트를 죽였다.

1) 인코딩 — 한글 윈도우의 콘솔 기본 코드페이지는 cp949 다.
   여기에 '—' 나 '→' 를 print 하면 UnicodeEncodeError 로 **프로세스가 죽는다.**
   전사 결과에 한자·이모지가 섞여도 같은 일이 난다. 출력 때문에 서버가
   내려가는 건 말이 안 되므로 utf-8 + errors='replace' 로 못 박는다.

2) 버퍼링 — stdout 이 터미널이 아니면(파일·파이프로 넘기면) 블록 버퍼링을 한다.
   그러면 모델 내려받기·로딩처럼 몇 분 걸리는 구간에서 화면이 빈 채로 멈춰 있어
   죽은 건지 도는 건지 알 수가 없다.
"""
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

app = FastAPI(title="local whisper")

# main() 에서 채운다
model = None
model_name = ""


@app.get("/v1/models")
def models():
    """살아 있는지 확인용. 앱은 안 쓰지만 curl 로 찔러 보기 좋다."""
    return {"object": "list", "data": [{"id": model_name, "object": "model"}]}


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model_: str = Form("", alias="model"),
    language: str = Form(""),
    prompt: str = Form(""),
    temperature: float = Form(0.0),
    response_format: str = Form("json"),
):
    """
    OpenAI 전사 엔드포인트 흉내.

    앱이 보내는 필드를 그대로 받는다. `model` 은 무시한다 — 어떤 모델을 쓸지는
    이 서버를 띄울 때 정하지 요청마다 바꾸지 않는다.
    """
    raw = await file.read()
    if not raw:
        return JSONResponse({"error": {"message": "빈 오디오"}}, status_code=400)

    started = time.perf_counter()
    try:
        segments, info = model.transcribe(
            io.BytesIO(raw),
            language=language or None,
            initial_prompt=prompt or None,
            temperature=temperature,
            # 무음에서 자막 상투어를 지어내는 걸 줄인다.
            # 앱에도 같은 취지의 방어가 두 겹 더 있다 (src/lib/transcribe.ts).
            vad_filter=True,
            condition_on_previous_text=False,
        )
        text = "".join(s.text for s in segments).strip()
    except Exception as err:  # noqa: BLE001 — 무엇이 터지든 500 으로 알려야 한다
        print(f"  ! 전사 실패: {err}", file=sys.stderr)
        return JSONResponse({"error": {"message": str(err)}}, status_code=500)

    took = time.perf_counter() - started
    lang = getattr(info, "language", "?")
    print(f"  {len(raw) / 1024:6.0f}KB  {took:5.2f}s  [{lang}]  {text[:60]}")

    return {"text": text}


def load(name: str):
    """GPU 를 먼저 시도하고, 안 되면 CPU 로 떨어진다."""
    from faster_whisper import WhisperModel

    for device, compute in (("cuda", "int8_float16"), ("cpu", "int8")):
        try:
            print(f"  모델 여는 중: {name} ({device}/{compute}) …")
            m = WhisperModel(name, device=device, compute_type=compute)
            print(f"  준비 완료 — {device.upper()}")
            return m
        except Exception as err:  # noqa: BLE001
            if device == "cpu":
                raise
            print(f"  GPU 사용 불가 ({type(err).__name__}) → CPU 로 진행합니다")
    raise RuntimeError("unreachable")


def main() -> None:
    global model, model_name

    ap = argparse.ArgumentParser(description="로컬 Whisper 서버 (OpenAI 호환)")
    ap.add_argument(
        "--model",
        default="large-v3-turbo",
        help="large-v3-turbo(기본) / large-v3 / medium / small / base. 작을수록 빠르고 부정확",
    )
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument(
        "--host",
        default="127.0.0.1",
        help="기본은 이 PC에서만 접속 가능. 팀에 공유하려면 0.0.0.0 (인증 없음 주의)",
    )
    args = ap.parse_args()

    model_name = args.model
    print("\n로컬 Whisper 서버")
    print("  첫 실행은 모델을 내려받습니다 (large-v3-turbo 약 1.6GB, 한 번만)\n")
    model = load(args.model)

    print(f"\n  듣는 중: http://{args.host}:{args.port}/v1")
    print("\n  .env.local 에 이렇게 넣고 dev 서버를 다시 띄우세요:\n")
    print(f"    TRANSCRIBE_BASE_URL=http://{args.host}:{args.port}/v1")
    print(f"    TRANSCRIBE_MODEL={args.model}\n")

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
