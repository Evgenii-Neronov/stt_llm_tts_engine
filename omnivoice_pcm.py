"""Local OmniVoice PCM service and voice-clone prompt registry."""
import argparse
import base64
import binascii
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import logging
from pathlib import Path
import re
import shutil
import subprocess
import threading
import uuid
import wave

import numpy as np
import torch
from omnivoice import OmniVoice, VoiceClonePrompt

RATE = 24000
MAX_UPLOAD = 10 * 1024 * 1024
VOICE_ID = re.compile(r"omni-[0-9a-f]{32}")
LANGUAGES = {"ru", "en", "de", "fr", "tl"}
logger = logging.getLogger("omnivoice-service")


class VoiceLibrary:
    def __init__(self, model, directory):
        self.model = model
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()

    def voices(self):
        voices = []
        for path in self.directory.iterdir():
            if not VOICE_ID.fullmatch(path.name):
                continue
            try:
                data = json.loads((path / "voice.json").read_text(encoding="utf-8"))
                if (path / "prompt.pt").is_file():
                    voices.append(data)
            except (OSError, ValueError):
                logger.warning("Could not read voice profile %s", path.name)
        return sorted(voices, key=lambda voice: voice["name"].casefold())

    def create(self, request):
        name = request["name"].strip()
        transcript = request["transcript"].strip()
        if not 1 <= len(name) <= 64 or not 1 <= len(transcript) <= 2000:
            raise ValueError("Enter a name and the exact words spoken in the reference.")
        raw = base64.b64decode(request["audio"], validate=True)
        if not 0 < len(raw) <= MAX_UPLOAD:
            raise ValueError("Reference must be at most 10 MiB.")
        try:
            decoded = subprocess.run(
                ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", "pipe:0", "-vn",
                 "-ac", "1", "-ar", str(RATE), "-t", "30.1", "-f", "s16le", "pipe:1"],
                input=raw, capture_output=True, timeout=20, check=True,
            ).stdout
        except (subprocess.SubprocessError, FileNotFoundError) as error:
            raise ValueError("Could not decode the reference. Use a valid audio file and install FFmpeg.") from error
        duration = len(decoded) / (2 * RATE)
        if not 3 <= duration <= 30:
            raise ValueError("Reference must contain 3–30 seconds of audio.")
        samples = np.frombuffer(decoded, dtype="<i2").astype(np.float32) / 32768
        if np.max(np.abs(samples)) < 0.005:
            raise ValueError("Reference is too quiet. Use a recording with clear speech.")
        profile = {"id": "omni-" + uuid.uuid4().hex, "name": name, "seconds": round(duration, 2)}
        pending = self.directory / ("." + profile["id"])
        pending.mkdir()
        try:
            with self.lock, torch.inference_mode():
                prompt = self.model.create_voice_clone_prompt(
                    ref_audio=(torch.from_numpy(samples).unsqueeze(0), RATE), ref_text=transcript,
                )
                prompt.save(str(pending / "prompt.pt"))
            (pending / "voice.json").write_text(json.dumps(profile, ensure_ascii=False), encoding="utf-8")
            pending.rename(self.directory / profile["id"])
        finally:
            if pending.exists():
                shutil.rmtree(pending)
        return profile

    @lru_cache(maxsize=16)
    def prompt(self, voice):
        return VoiceClonePrompt.load(str(self.directory / voice / "prompt.pt"))

    def synthesize(self, request):
        voice = request["voice"]
        text = request["text"].strip()
        if not VOICE_ID.fullmatch(voice) or not (self.directory / voice / "prompt.pt").is_file():
            raise ValueError("Unknown OmniVoice profile.")
        if not 0 < len(text) <= 2000:
            raise ValueError("Enter 1–2000 characters to synthesize.")
        language = request.get("language")
        speed = max(0.4, min(2.6, float(request.get("speed", 1))))
        with self.lock, torch.inference_mode():
            audio = self.model.generate(text=text, voice_clone_prompt=self.prompt(voice),
                language=language if language in LANGUAGES else None, speed=speed, num_step=16)[0]
        return (np.clip(np.asarray(audio).reshape(-1), -1, 1) * 32767).astype("<i2").tobytes()


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body, content_type, **headers):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in headers.items():
            self.send_header(key, str(value))
        self.end_headers()
        self.wfile.write(body)

    def json_reply(self, status, value):
        self.reply(status, json.dumps(value, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def do_GET(self):
        if self.path == "/voices":
            self.json_reply(200, self.server.library.voices())
        else:
            self.json_reply(404, {"error": "Route not found."})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            maximum = ((MAX_UPLOAD + 2) // 3) * 4 + 16384 if self.path == "/voices" else 16384
            if not 0 < length <= maximum:
                self.json_reply(413, {"error": "Invalid request size."})
                return
            request = json.loads(self.rfile.read(length))
            if self.path == "/voices":
                self.json_reply(201, self.server.library.create(request))
            elif self.path in ("/pcm", "/preview"):
                audio = self.server.library.synthesize(request)
                if self.path == "/pcm":
                    self.reply(200, audio, "application/octet-stream", **{"X-Sample-Rate": RATE})
                else:
                    output = io.BytesIO()
                    with wave.open(output, "wb") as clip:
                        clip.setparams((1, 2, RATE, 0, "NONE", ""))
                        clip.writeframes(audio)
                    self.reply(200, output.getvalue(), "audio/wav")
            else:
                self.json_reply(404, {"error": "Route not found."})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return
        except (ValueError, KeyError, TypeError, AttributeError, binascii.Error) as error:
            self.json_reply(400, {"error": str(error)})
        except Exception:
            logger.exception("OmniVoice operation failed")
            self.json_reply(500, {"error": "OmniVoice failed. See the local model service log."})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--voices", type=Path, required=True)
    parser.add_argument("--device", default="cuda:0")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    dtype = torch.float32 if args.device == "cpu" else torch.float16
    model = OmniVoice.from_pretrained(args.model, device_map=args.device, dtype=dtype, local_files_only=True)
    model.eval()
    server = ThreadingHTTPServer(("127.0.0.1", 5194), Handler)
    server.library = VoiceLibrary(model, args.voices)
    logger.info("OmniVoice ready at 127.0.0.1:5194 (%s)", args.device)
    server.serve_forever()


if __name__ == "__main__":
    main()
