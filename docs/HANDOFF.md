# Maintainer handoff

## Start here

- Read [architecture](ARCHITECTURE.md) and the [launch instructions](../README.md).
- Run `dotnet build` from the repository root. To launch the model services and app together, run `pwsh -File ./start-local.ps1 -Models <path-to-models>`. The default model directory is a sibling of the repository. Setup details and Python dependencies are in the root README.
- The pipeline is intentionally local. Keep model weights, archives, Python dependencies, logs, local recordings, build outputs, and credentials outside Git. Langfuse keys come from `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`; prompt editing works without them via the browser.

## Code entry points

| Change | Start in |
| --- | --- |
| Microphone capture, endpointing, barge-in, reset and playback | `wwwroot/capture.js` and `wwwroot/app.js` |
| Streaming protocol, LLM prompt and cancellation | `Program.cs`, especially `VoiceHub.Listen` and `VoiceHub.Run` |
| Recognizer sessions and backend selection | `OnlineStt.cs`, `online_stt.py` |
| Supported language enum, user-facing confirmation and voice selection | `Languages.cs` |
| First audible audio, transport, and TTS cache | `PcmTts.cs`, `piper_pcm.py` |
| Bootstrapping models and processes | `setup_models.py`, `start-local.ps1` |

## Smoke test after changes

1. Check `GET http://127.0.0.1:5188/health`, send a short text message, and verify the stream displays tokens and plays PCM.
2. Enable the microphone and speak two utterances without disabling it. Speak over a longer answer and check that audio stops and the interrupted state appears. Test with speakers as well as a headset.
3. Request a switch to English, then back to the initial language. Check the selector, voice and STT language. A translation request alone should not switch the active language.
4. Click a user and an agent message and replay each one. Test repeated STT and explicit re-synthesis.
5. Reset while playback is active. Verify that chat, timeline and audio are cleared and that the mic can still accept the next utterance.

## Current limits

- Previous timing tests used warmed local models and prerecorded audio. Recheck physical microphone echo cancellation, voice-to-voice p95, and behavior with noise and different accents.
- Language changes use an LLM-generated control marker, with a manual selector available if the model misinterprets a request. Each active recognizer expects speech in the current language.
- Langfuse supports fetching named text prompts. Trace export and OpenAI Realtime adapters are outside the current implementation. Check model licenses before redistributing Tagalog weights.
