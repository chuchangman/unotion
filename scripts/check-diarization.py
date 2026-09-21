# /// script
# requires-python = ">=3.10"
# dependencies = ["sherpa-onnx", "numpy", "av"]
# ///
"""
화자 분리 측정기.

    uv run scripts/check-diarization.py 회의녹음.webm
    uv run scripts/check-diarization.py 회의녹음.m4a --speakers 5

─────────────────────────────────────────────────────────────────────────────
왜 붙이기 전에 재보는가

화자 분리는 "되냐 안 되냐" 가 아니라 **얼마나 틀리냐** 의 문제다.
공개 벤치마크에서 pyannote 계열은 AMI SDM(한 방, 마이크 하나 멀리)에서
DER 약 20% 다 — 발화 시간의 1/5이 엉뚱한 사람에게 붙는다는 뜻이다.
그 수치는 영어 회의 기준이라 한국어 5명 회의에서 어떻게 나올지는 모른다.

그래서 붙이기 전에 **실제 회의실에서 쓰는 그 마이크로** 2분쯤 녹음해서
여기에 넣어 본다. 갈라지지 않으면 모델을 바꾸는 게 아니라 마이크를 바꾸는 게
먼저다 — 입력이 깨끗해야 시작이 된다.

─────────────────────────────────────────────────────────────────────────────
알아둘 것

* 첫 실행은 모델 2개를 내려받는다 (약 35MB, ~/.cache/unotion-diarization).
* GPU 가 필요 없다. CPU 로 돈다 — 실측 RTF 0.05 (1시간 회의 ≈ 3분).
* webm·m4a·mp3·wav 아무거나 넣어도 된다. PyAV 가 디코딩한다
  (ffmpeg 를 따로 깔 필요가 없다 — 앱이 만드는 녹음 구간이 webm/opus 다).
* 인원수를 알면 --speakers 로 주는 게 낫다. 자동 판정은 사람 수를 자주 틀린다.
"""

from __future__ import annotations

import argparse
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

# 한글 윈도우 콘솔(cp949)에서 출력이 깨지거나 죽지 않도록
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

CACHE = Path.home() / ".cache" / "unotion-diarization"
RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download"

SEGMENTATION = (
    "sherpa-onnx-pyannote-segmentation-3-0",
    f"{RELEASE}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
)
# 다국어(zh+en) 임베딩. 영어 전용 TitaNet 보다 한국어에 나을 것으로 보고 골랐다.
# (nemo_en_titanet_large 는 sherpa-onnx 가 로드하지 못했다 — 지원 목록 밖)
EMBEDDING = (
    "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    f"{RELEASE}/speaker-recongition-models/"
    "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
)

SAMPLE_RATE = 16000


def fetch(name: str, url: str) -> Path:
    """없으면 받고, 있으면 그대로 쓴다"""
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / url.rsplit("/", 1)[-1]
    if not dest.exists():
        print(f"  내려받는 중: {name} …")
        urllib.request.urlretrieve(url, dest)

    if dest.suffix == ".bz2":
        out = CACHE / name
        if not out.exists():
            import tarfile

            with tarfile.open(dest, "r:bz2") as tar:
                tar.extractall(CACHE)
        return out / "model.onnx"
    return dest


def decode(path: Path) -> np.ndarray:
    """
    무슨 형식이든 16kHz 모노 float32 로 만든다.

    PyAV 가 ffmpeg 를 품고 있어서 webm/opus 도 그대로 읽는다 —
    앱이 만드는 녹음 구간이 webm 이라 이게 없으면 변환부터 해야 한다.
    """
    import av

    with av.open(str(path)) as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            sys.exit(f"오디오 트랙이 없습니다: {path}")

        resampler = av.AudioResampler(format="flt", layout="mono", rate=SAMPLE_RATE)
        chunks: list[np.ndarray] = []
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        # 리샘플러 내부 버퍼를 비운다 (마지막 몇 ms 가 여기 남는다)
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))

    if not chunks:
        sys.exit(f"오디오를 읽지 못했습니다: {path}")
    return np.concatenate(chunks).astype(np.float32)


def main() -> None:
    ap = argparse.ArgumentParser(description="회의 녹음의 화자 분리를 재 본다")
    ap.add_argument("audio", help="회의 녹음 (webm/m4a/mp3/wav …)")
    ap.add_argument(
        "--speakers",
        type=int,
        default=0,
        help="회의 참석 인원. 알면 주는 쪽이 정확하다. 0 이면 자동 판정",
    )
    ap.add_argument(
        "--threshold",
        type=float,
        default=0.5,
        help="자동 판정일 때만 쓰인다. 낮출수록 사람을 더 잘게 쪼갠다",
    )
    ap.add_argument("--threads", type=int, default=4)
    args = ap.parse_args()

    path = Path(args.audio)
    if not path.exists():
        sys.exit(f"파일이 없습니다: {path}")

    print("\n모델 준비")
    seg = fetch(*SEGMENTATION)
    emb = fetch(*EMBEDDING)

    print(f"\n읽는 중: {path.name}")
    audio = decode(path)
    duration = len(audio) / SAMPLE_RATE
    print(f"  길이 {duration / 60:.1f}분 ({duration:.0f}초)")
    if duration < 20:
        print("  ! 너무 짧습니다. 화자 분리는 최소 1~2분은 있어야 의미가 있습니다.")

    import sherpa_onnx

    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(seg)
            ),
            num_threads=args.threads,
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(emb), num_threads=args.threads
        ),
        clustering=sherpa_onnx.FastClusteringConfig(
            # -1 이면 threshold 로 사람 수를 알아서 정한다
            num_clusters=args.speakers if args.speakers > 0 else -1,
            threshold=args.threshold,
        ),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        sys.exit("설정이 잘못됐습니다 (모델 경로를 확인하세요)")

    print("\n화자 분리 중 …")
    started = time.perf_counter()
    result = sherpa_onnx.OfflineSpeakerDiarization(config).process(audio)
    segments = result.sort_by_start_time()
    took = time.perf_counter() - started

    speakers = sorted({s.speaker for s in segments})
    if not speakers:
        print("\n말소리를 찾지 못했습니다. 마이크 입력을 확인하세요.\n")
        return

    talk = {s: 0.0 for s in speakers}
    for s in segments:
        talk[s.speaker] += s.end - s.start
    total = sum(talk.values()) or 1.0

    print(f"\n처리 {took:.1f}초  →  RTF {took / duration:.3f}  (1보다 작으면 실시간보다 빠름)")
    print(f"1시간 회의라면 약 {took / duration * 60:.1f}분 걸립니다\n")

    known = f" (알려준 인원 {args.speakers}명)" if args.speakers else " — 자동 판정"
    print(f"찾은 화자: {len(speakers)}명{known}")
    for s in speakers:
        print(f"  화자 {s}: {talk[s]:6.1f}초  ({talk[s] / total * 100:4.1f}%)")

    print(f"\n구간 {len(segments)}개")
    for s in segments:
        mm, ss = divmod(int(s.start), 60)
        me, se = divmod(int(s.end), 60)
        print(f"  {mm:02d}:{ss:02d} ~ {me:02d}:{se:02d}  화자 {s.speaker}")

    print(
        "\n이제 눈으로 확인하세요 — 실제로 말한 사람과 화자 번호가 맞습니까?\n"
        "맞지 않으면 모델을 바꾸기 전에 마이크부터 의심하세요.\n"
    )


if __name__ == "__main__":
    main()
