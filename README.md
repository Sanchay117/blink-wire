# BlinkWire — Even Realities G2 Messaging & News HUD

**Hackathon Track:** Messaging & News *(Telegram, Slack, Discord)* + **Best Telegram Integration** special prize  
**Display Target:** Even Realities G2 (`576 × 288` 4-bit monochrome green HUD + G2 `16 kHz` mic + temple touchpad / R1 ring)

## Problem Solved
Pulling out your phone mid-walk or mid-meeting just to check whether a Telegram ping is urgent—and send a 4-word reply—breaks focus. **BlinkWire** turns the Even G2 into a glanceable triage wire: read urgent incoming messages, pick one of 3 contextual AI-drafted replies (or speak a short voice reply on the G2 mic), and confirm-send with a 2-tap safety lock.

## Key Features (Zero Mocks)
- **Live Telegram Bot API (`getMe`, `getUpdates`, `sendMessage`):** Real incoming messages appear automatically; replies post live to the real chat.
- **Live Slack & Discord Triage (Optional):** Connects to real Slack (`conversations.history` / `chat.postMessage`) and Discord (`v10/channels/*/messages`) channels alongside Telegram.
- **Live Breaking News Feed:** Pulls live Hacker News top stories right on boot.
- **1-Tap AI Quick Replies:** Calls OpenRouter or OpenAI (`gpt-4o-mini`) to draft 3 short, G2-sized replies (≤ 38 chars) with automatic urgency tagging (`URGENT` / `ACTION` / `FYI`).
- **Real G2 Microphone Voice Replies:** Captures `16 kHz s16le` mono PCM frames from `bridge.audioControl(true)`, encodes a valid RIFF WAV buffer in TypeScript, and transcribes via Groq Whisper or OpenAI Whisper.
- **2-Tap Safety Guardrail:** Tap 1 arms the reply with a 6-second countdown (`CONFIRM SEND`); Tap 2 fires the real API write. Swiping cancels immediately so an accidental temple brush can never send a message.
- **Flicker-Free 3-Container G2 Layout:** Uses persistent Header / Body / Footer containers updated via serialized `textContainerUpgrade` calls and protobuf-safe `OsEventTypeList` event decoding.

## Quick Setup (60 Seconds)
1. Install dependencies:
   ```bash
   npm install
   ```
2. Optional: copy `.env.example` to `.env.local` and fill in your real tokens (or enter them directly in the Companion WebView UI):
   - **Telegram (30s):** Message `@BotFather` → `/newbot` → paste `TELEGRAM_BOT_TOKEN`, then message your bot so live updates appear.
   - **AI Drafts (optional):** `OPENROUTER_API_KEY` or `OPENAI_API_KEY`.
   - **Voice STT (optional):** `GROQ_API_KEY` or `OPENAI_API_KEY`.
3. Start dev server (Vite + built-in live API relay on port `5173`):
   ```bash
   npm run dev
   ```
4. Launch inside the official Even Hub Simulator:
   ```bash
   npm run simulate
   ```
5. Build & package `.ehpk` for Even Hub:
   ```bash
   npm run pack
   ```

## Gesture Map on Even G2
| Gesture | Inbox | Reply Picker | Voice Capture | Confirm Send |
|---|---|---|---|---|
| **Swipe Up / Down** | Previous / Next message | Move selection cursor | Cancel capture | Cancel send |
| **Single Tap** | Open AI Quick Replies | Arm selected reply / Start mic | Stop & transcribe | **Send live message** |
| **Double-Tap** | Exit app (`shutDownPageContainer(1)`) | Exit app | Stop mic & exit | Cancel & exit |
