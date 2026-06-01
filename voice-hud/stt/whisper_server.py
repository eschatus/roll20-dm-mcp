"""
Whisper STT sidecar for the DM Whisper voice HUD.

Long-running process: loads faster-whisper once (resident on GPU), then serves
transcription requests over a simple newline-delimited JSON protocol on stdin/stdout.
The Electron main process spawns this and pipes audio paths to it.

Protocol
--------
Request  (one JSON object per line on stdin):
    {"id": "<req-id>", "wav": "C:/path/to/audio.wav", "initial_prompt": "Strahd, Ireena, ..."}
Response (one JSON object per line on stdout):
    {"id": "<req-id>", "text": "...", "avg_logprob": -0.31, "no_speech_prob": 0.02,
     "low_confidence": false, "language": "en", "duration": 3.4}
    {"id": "<req-id>", "error": "..."}             # on failure

A single line  {"ready": true, "model": "...", "device": "..."}  is emitted on stdout
once the model has loaded, so the parent knows it can start sending requests.

All diagnostics go to stderr; stdout carries only protocol JSON.

Run:
    .venv/Scripts/python whisper_server.py [--model large-v3-turbo] [--device cuda]
                                            [--compute-type float16] [--lang en]
                                            [--lowconf -0.6]
"""

import argparse
import glob
import json
import os
import sys
import time


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def _register_cuda_dll_dirs():
    """Add the pip-installed NVIDIA CUDA lib dirs (cuBLAS, cuDNN) to the Windows DLL
    search path before ctranslate2 loads. ctranslate2's Windows wheel doesn't bundle
    cublas64_12.dll / cudnn, but the nvidia-*-cu12 wheels ship them under
    site-packages/nvidia/*/bin. Without this, CUDA transcription fails with
    'Library cublas64_12.dll is not found'."""
    if sys.platform != "win32":
        return
    candidates = [os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")]
    try:
        import site
        for base in site.getsitepackages() + [site.getusersitepackages()]:
            candidates.append(os.path.join(base, "nvidia"))
    except Exception:
        pass
    seen = set()
    for nv in candidates:
        for binpath in glob.glob(os.path.join(nv, "*", "bin")):
            if binpath in seen or not os.path.isdir(binpath):
                continue
            seen.add(binpath)
            try:
                os.add_dll_directory(binpath)
            except OSError:
                pass
    if seen:
        # ctranslate2 loads cuBLAS/cuDNN via plain LoadLibrary, which searches PATH
        # (not os.add_dll_directory's list) — so prepend the bin dirs to PATH too.
        os.environ["PATH"] = os.pathsep.join(sorted(seen)) + os.pathsep + os.environ.get("PATH", "")
        log(f"registered {len(seen)} CUDA DLL dir(s)")


_register_cuda_dll_dirs()


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--compute-type", default="float16")
    ap.add_argument("--lang", default="en")
    # Average-logprob threshold below which we flag the transcript for review.
    ap.add_argument("--lowconf", type=float, default=-0.6)
    # no_speech_prob above this also flags low confidence.
    ap.add_argument("--nospeech", type=float, default=0.6)
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # pragma: no cover
        emit({"fatal": f"faster-whisper import failed: {e}"})
        log("Install deps into the 3.12 venv: pip install -r requirements.txt")
        return 1

    log(f"Loading {args.model} on {args.device} ({args.compute_type})...")
    t0 = time.time()
    try:
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    except Exception as e:
        emit({"fatal": f"model load failed: {e}"})
        log("If CUDA libs are missing, ensure cuBLAS/cuDNN are on PATH, "
            "or fall back to --device cpu --compute-type int8.")
        return 1
    log(f"Model loaded in {time.time() - t0:.1f}s")
    emit({"ready": True, "model": args.model, "device": args.device})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            emit({"error": f"bad request json: {e}"})
            continue

        req_id = req.get("id")
        wav = req.get("wav")
        if not wav:
            emit({"id": req_id, "error": "missing 'wav' path"})
            continue

        initial_prompt = req.get("initial_prompt") or None
        lang = req.get("lang", args.lang) or None

        try:
            segments, info = model.transcribe(
                wav,
                language=lang,
                initial_prompt=initial_prompt,
                beam_size=5,
                vad_filter=True,
            )
            # segments is a generator — materialize it to read the full transcript.
            seg_list = list(segments)
            text = "".join(s.text for s in seg_list).strip()

            if seg_list:
                avg_logprob = sum(s.avg_logprob for s in seg_list) / len(seg_list)
                no_speech = max(s.no_speech_prob for s in seg_list)
            else:
                avg_logprob = -10.0
                no_speech = 1.0

            low_conf = (avg_logprob < args.lowconf) or (no_speech > args.nospeech) or (text == "")

            emit({
                "id": req_id,
                "text": text,
                "avg_logprob": round(avg_logprob, 4),
                "no_speech_prob": round(no_speech, 4),
                "low_confidence": bool(low_conf),
                "language": info.language,
                "duration": round(info.duration, 2),
            })
        except Exception as e:
            emit({"id": req_id, "error": str(e)})

    return 0


if __name__ == "__main__":
    sys.exit(main())
