"""Local Piper split-model service. Response body is streaming mono PCM16 LE."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys

import numpy as np
import onnxruntime as ort
from piper import PiperVoice
from piper.config import PiperConfig

VOICE_NAMES = (
    "ru_RU-dmitri-medium", "ru_RU-irina-medium", "en_US-lessac-medium", "de_DE-thorsten-medium",
    "fr_FR-siwis-medium", "tl_PH-filipino-medium",
)
root = Path(sys.argv[1]).resolve()
if root.is_file():
    root = root.parent

class SplitVoice:
    def __init__(self, path):
        self.config = PiperConfig.from_dict(json.loads(Path(str(path) + ".json").read_text(encoding="utf-8")))
        options = ort.SessionOptions()
        options.intra_op_num_threads = 3
        options.inter_op_num_threads = 1
        self.encoder = ort.InferenceSession(str(path.with_suffix(".encoder.onnx")), options, providers=["CPUExecutionProvider"])
        self.decoder = ort.InferenceSession(str(path.with_suffix(".decoder.onnx")), options, providers=["CPUExecutionProvider"])
        self.phonemizer = PiperVoice(session=self.encoder, config=self.config)

    def pcm(self, text, speed):
        config = self.config
        scales = np.array([config.noise_scale, config.length_scale / speed, config.noise_w_scale], dtype=np.float32)
        for sentence in self.phonemizer.phonemize(text):
            ids = np.array([self.phonemizer.phonemes_to_ids(sentence)], dtype=np.int64)
            args = {"input": ids, "input_lengths": np.array([ids.shape[1]], dtype=np.int64), "scales": scales}
            latent = self.encoder.run(["z"], args)[0]
            frames = latent.shape[-1]
            begin = 0
            while begin < frames:
                end = min(frames, begin + (16 if begin == 0 else 64))
                left, right = max(0, begin - 12), min(frames, end + 12)
                samples = self.decoder.run(None, {"z": latent[..., left:right]})[0].reshape(-1)
                hop = len(samples) // (right - left)
                audio = samples[(begin - left) * hop:(end - left) * hop]
                yield (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
                begin = end

voices = {}
warmup = ("Готов к разговору.", "Готова к разговору.", "Ready to talk.", "Ich bin bereit.", "Je suis prêt.", "Magandang umaga.")
for name, greeting in zip(VOICE_NAMES, warmup):
    path = root / (name + ".onnx")
    if not path.with_suffix(".decoder.onnx").exists():
        continue
    voice = SplitVoice(path)
    for _ in voice.pcm(greeting, 1):
        pass
    voices[name] = voice
    print("ready", name, flush=True)

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/pcm":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16384:
                self.send_error(411)
                return
            request = json.loads(self.rfile.read(length))
            text = request["text"].strip()
            if not text or len(text) > 2000:
                self.send_error(400)
                return
            voice = voices.get(request.get("voice", VOICE_NAMES[0]))
            if voice is None:
                self.send_error(503, "Requested voice is not installed")
                return
            chunks = voice.pcm(text, max(0.4, min(2.6, float(request.get("speed", 1)))))
            first = next(chunks, None)
            if first is None:
                self.send_error(422)
                return
        except (ValueError, KeyError, TypeError):
            self.send_error(400)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("X-Sample-Rate", str(voice.config.sample_rate))
        self.end_headers()
        try:
            self.wfile.write(first)
            for chunk in chunks:
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 5193), Handler).serve_forever()
