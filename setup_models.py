"""Download VoiceLab's free local model files and prepare split Piper models."""
import argparse
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
from urllib.request import ProxyHandler, build_opener
import zipfile

TONE = "sherpa-onnx-streaming-t-one-russian-2025-09-08"
LLAMA = "b12413"
VOICE = "ru_RU-dmitri-medium.onnx"
PIPER = "https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/dmitri/medium/"
HF = "https://huggingface.co/tauqir02/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf"
LLAMA_BASE = f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA}/"
NATIVE = (f"llama-{LLAMA}-bin-win-cuda-12.4-x64.zip", "cudart-llama-bin-win-cuda-12.4-x64.zip")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=Path, default=Path(__file__).resolve().parent.parent / "models")
    args = parser.parse_args()
    models = args.models.resolve()
    models.mkdir(parents=True, exist_ok=True)
    opener = build_opener(ProxyHandler({}))

    def fetch(file, url):
        path = models / file
        if not path.exists():
            pending = path.with_suffix(path.suffix + ".part")
            print(f"Downloading {file}", flush=True)
            with opener.open(url, timeout=40) as src, pending.open("wb") as out:
                shutil.copyfileobj(src, out, 1024 * 1024)
            pending.replace(path)
        return path

    urls = [(TONE+".tar.bz2", f"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/{TONE}.tar.bz2"),
            ("qwen3-1.7b-q4_k_m.gguf", HF), (VOICE, PIPER+VOICE), (VOICE+".json", PIPER+VOICE+".json"),
            ("piper-split.py", "https://raw.githubusercontent.com/OHF-Voice/piper1-gpl/main/src/piper/split_voice_for_streaming.py")]
    urls += [(name, LLAMA_BASE+name) for name in NATIVE]
    vosk = ("vosk-model-small-en-us-0.15", "vosk-model-small-de-0.15",
            "vosk-model-small-fr-0.22", "vosk-model-tl-ph-generic-0.6")
    urls += [(name+".zip", f"https://alphacephei.com/vosk/models/{name}.zip") for name in vosk]
    voices = {
        "ru_RU-irina-medium": "ru/ru_RU/irina/medium",
        "en_US-lessac-medium": "en/en_US/lessac/medium",
        "de_DE-thorsten-medium": "de/de_DE/thorsten/medium",
        "fr_FR-siwis-medium": "fr/fr_FR/siwis/medium",
    }
    for voice, folder in voices.items():
        name = voice + ".onnx"
        url = "https://huggingface.co/rhasspy/piper-voices/resolve/main/" + folder + "/" + name
        urls += [(name, url), (name+".json", url+".json")]
    filipino_repo = "IhorShevchuk/piper-voice-tl-filipino"
    with opener.open("https://huggingface.co/api/models/" + filipino_repo, timeout=20) as response:
        metadata = json.load(response)
    source = next(item["rfilename"] for item in metadata["siblings"] if item["rfilename"].endswith(".onnx"))
    filipino = "tl_PH-filipino-medium.onnx"
    url = f"https://huggingface.co/{filipino_repo}/resolve/{metadata['sha']}/{source}"
    urls += [(filipino, url), (filipino+".json", url+".json")]
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda item: fetch(*item), urls))
    for name in vosk:
        if not (models / name / "am").is_dir():
            with zipfile.ZipFile(models / (name+".zip")) as archive:
                archive.extractall(models)
    if not (models / TONE / "model.onnx").exists():
        with tarfile.open(models / (TONE+".tar.bz2")) as archive:
            archive.extractall(models, filter="data")
    if not (models / "llama" / "llama-server.exe").exists():
        for name in NATIVE:
            with zipfile.ZipFile(models / name) as archive:
                archive.extractall(models / "llama")
    for name in (VOICE, filipino, *(voice + ".onnx" for voice in voices)):
        path = models / name
        if not path.with_suffix(".decoder.onnx").exists():
            subprocess.run([sys.executable, str(models / "piper-split.py"), str(path)], check=True)

if __name__ == "__main__":
    main()
