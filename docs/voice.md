# Voice agents

Customers can **talk** to an agent instead of typing: on the website (a microphone button in the chat widget) and on
**phone calls** (a Plivo or Exotel number). The agent understands English, Hindi, Hinglish and 9 other Indian languages,
answers from the same sources and Q&A answers as the chat, and replies out loud in the caller's language. Callers can
interrupt it at any time, and "let me talk to a person" hands the conversation to the owner (on calls: transfers the call).

## How it works

```
caller audio ─► voice gateway (apps/voice, WebSockets)
                 │  voice activity detection: when did the caller start and stop talking?
                 ▼
             speech-to-text (Sarvam saaras)          ─ language detected here
                 ▼
             the normal answer pipeline               ─ search, Q&A answers, credits, cache, handoff, cost records
                 │  (a short spoken style: 1–3 sentences, no lists or links)
                 ▼
             text-to-speech (Sarvam Bulbul), one sentence at a time, while the rest of the answer is still being written
                 ▼
             audio back to the caller
```

- **Low latency**: the first sentence is spoken while the model is still writing the rest. The time from the end of the
  caller's sentence to the first audio is recorded for every answer (`ai_calls.first_audio_ms`); the target is under 1.5 s
  with production models (speech-to-text ~300–500 ms, first words of the answer ~300–700 ms, first sentence of speech
  ~200–400 ms).
- **Barge-in**: when the caller talks while the agent is thinking or speaking, the reply stops at once (the browser or the
  phone provider is told to drop audio not yet played) and the new sentence is answered. `VOICE_BARGE_IN=off` turns it off.
- **Credits and records**: each spoken answer uses one message credit, like a typed one. Voice conversations appear in
  the dashboard's Chats (channel `voice` for the website, `phone` for calls, with the caller's number) and in Analytics,
  and in the admin app (answer traces, costs, first-audio time).
- **Handoff**: follows the agent's "Let customers ask for a human" setting. On the website, the widget switches to the
  team's typed replies. On a call with a **transfer number**, the call is transferred to it; without one, the caller hears
  the handoff message and the owner gets the usual alert (with the caller's number to call back).

## Setting it up

1. **Sarvam**: set `SARVAM_API_KEY` (the same key as for WhatsApp voice notes). Speech-to-text and text-to-speech both use it.
2. **Run the voice gateway** next to the other apps: `pnpm --filter @chatbase/voice start` (port `VOICE_PORT`, default
   3002; `pnpm start` starts it with the others). It reads the same `.env`.
3. **Give it a public https address** through your reverse proxy (WebSockets must pass through; Caddy does this by
   default) and set `VOICE_PUBLIC_URL`, e.g. `https://voice.yourdomain.in`. The customer app uses it for the website
   microphone button and to show each agent's phone addresses.
4. In the dashboard, open the agent's **Voice** tab: turn on the microphone button, pick a voice and the language to use
   when the caller's can't be detected, the first thing it says, and the number to transfer calls to.

### Phone numbers

**Plivo**: buy an Indian number, create an Application with the agent's **Answer URL** (Voice tab, method POST) and link
the number to it. For transfers set `PLIVO_AUTH_ID` and `PLIVO_AUTH_TOKEN` (the gateway moves the call to a `<Dial>` of
the transfer number through Plivo's API). Audio is μ-law 8 kHz.

**Exotel**: in your call flow (App Bazaar), add a **Voicebot** applet with the agent's **Exotel stream URL** (Voice tab),
and after it a **Connect** applet to the owner's number. When a caller asks for a person, the gateway ends the Voicebot
leg and the flow continues to Connect. Audio is 16-bit PCM at 8 kHz (or what the applet announces).

The addresses contain the agent's secret voice token: anyone with them could start calls that use the agent's credits.
**Make new addresses** in the Voice tab if one leaks (then update Plivo / Exotel).

Phone-provider message formats change over time: after connecting a number, make a test call and check the gateway's log.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `VOICE_PUBLIC_URL` | none | Public address of the voice gateway (turns on website voice and the phone addresses). |
| `VOICE_PORT` | `3002` | The gateway's port. |
| `TTS_PROVIDER` | `sarvam` when `SARVAM_API_KEY` is set, else `mock` | `mock` beeps instead of speaking (development). |
| `SARVAM_TTS_MODEL`, `SARVAM_TTS_URL`, `TTS_TIMEOUT_MS` | `bulbul:v2`, Sarvam's API, `10000` | Text-to-speech. |
| `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN` | none | Needed to transfer Plivo calls. |
| `VOICE_VAD_THRESHOLD` | `600` | How loud (16-bit RMS) counts as speech; raise it on noisy lines. |
| `VOICE_SILENCE_MS` | `700` | How long a pause ends the caller's sentence. Lower = faster replies but more cut-offs. |
| `VOICE_MIN_SPEECH_MS`, `VOICE_MAX_UTTERANCE_MS` | `150`, `15000` | Shortest sound that counts as speech; longest sentence. |
| `VOICE_BARGE_IN` | on | `off`: the caller can't interrupt. |
| `VOICE_MAX_MINUTES` | `15` | Longest voice session or call. |
| `VOICE_MAX_PER_IP` | `3` | Website voice sessions at once per visitor address. |
| `VOICE_WEB_OUTPUT_RATE` | `22050` | Sample rate of the speech sent to browsers. |

## Security

- Website voice needs a ticket from the customer app, signed with `AUTH_SECRET`, valid for 2 minutes, only for agents with
  voice turned on; the gateway also checks the page's origin is `APP_URL`. Tickets are rate-limited per visitor address.
- Phone streams need the agent's secret voice token. Calls and sessions end after `VOICE_MAX_MINUTES`.
- Browsers ask the visitor before using the microphone; the widget's iframe is allowed to ask (`allow="microphone"`).
- Callers' audio is sent to Sarvam for transcription and speech; only the text is stored. Mention voice processing in
  your privacy policy.

## Testing

`pnpm smoke:voice` runs the website, Plivo and Exotel flows against fake Sarvam and Plivo servers: speech → answer →
speech, first-audio latency, barge-in, handoff, call transfer. See [testing.md](testing.md).
