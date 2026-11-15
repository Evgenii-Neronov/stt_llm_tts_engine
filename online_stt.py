"""Resident online STT worker. Each utterance uses one configured language."""
import base64
import json
import os
from pathlib import Path
import sys

import numpy as np
import sherpa_onnx

path = Path(os.environ["VOICELAB_STT_MODEL"])
tone = sherpa_onnx.OnlineRecognizer.from_t_one_ctc(
    model=str(path / "model.onnx"), tokens=str(path / "tokens.txt"), num_threads=2,
    sample_rate=8000, enable_endpoint_detection=False,
)
directories = {
    "en": "vosk-model-small-en-us-0.15", "de": "vosk-model-small-de-0.15",
    "fr": "vosk-model-small-fr-0.22", "tl": "vosk-model-tl-ph-generic-0.6",
}
vosk_models = {}

def vosk_model(code):
    import vosk

    if code not in vosk_models:
        vosk.SetLogLevel(-1)
        vosk_models[code] = vosk.Model(str(path.parent / directories[code]))
    return vosk_models[code]

code = "ru"
stream = None
committed = []
print("ready", flush=True)
for line in sys.stdin:
    request = json.loads(line)
    kind = request["kind"]
    try:
        text = ""
        if kind == "prepare":
            if request["language"] != "ru":
                vosk_model(request["language"])
        elif kind == "start":
            code = request.get("language") or "ru"
            committed = []
            if code == "ru":
                stream = tone.create_stream()
                stream.accept_waveform(16000, np.zeros(4800, dtype=np.float32))
            else:
                from vosk import KaldiRecognizer

                stream = KaldiRecognizer(vosk_model(code), 16000)
        elif stream is not None and code == "ru":
            if kind == "audio":
                audio = np.frombuffer(base64.b64decode(request["pcm"]), dtype="<i2").astype(np.float32) / 32768
                stream.accept_waveform(16000, audio)
            else:
                stream.accept_waveform(16000, np.zeros(10560, dtype=np.float32))
                stream.input_finished()
            while tone.is_ready(stream):
                tone.decode_stream(stream)
            text = tone.get_result(stream)
        elif stream is not None:
            if kind == "final":
                text = json.loads(stream.FinalResult())["text"]
            else:
                if stream.AcceptWaveform(base64.b64decode(request["pcm"])):
                    committed.append(json.loads(stream.Result())["text"])
                text = json.loads(stream.PartialResult())["partial"]
            text = " ".join(filter(None, [*committed, text]))
        print(json.dumps({"text": text}), flush=True)
    except Exception as error:
        stream = None
        print(json.dumps({"error": str(error)}), flush=True)
