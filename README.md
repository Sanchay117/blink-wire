# BlinkWire — Even Realities G2 Messaging & Telegram HUD

**Hackathon Track:** Messaging & News *(Telegram, Slack, Discord)* + **Best Telegram Integration** special prize  
**Display Target:** Even Realities G2 (`576 × 288` 4-bit monochrome green HUD + G2 `16 kHz` mic + temple touchpad / R1 ring)  
**Demo Video:** https://youtu.be/n6BBsNBZ6_w

## Problem Solved
Pulling out your phone mid-walk or mid-meeting just to check whether a Telegram message is urgent—or listen to a voice note on speakerless glasses—breaks flow. **BlinkWire** turns Even G2 into a fast, guarded messaging wire: glanceable inbox triage, auto-transcribed incoming Telegram voice notes, prefetched thread-aware AI replies, 1-tap `👍` reactions, G2 mic voice replies, and a server-enforced 2-tap safety lock.

## Key Features (Zero Mocks)
- **Deep Native Telegram Integration:**
  - **Auto-transcribes incoming Telegram voice notes** (`getFile` + Groq/OpenAI Whisper) so speakerless G2 glasses display `[VOICE 6s]: "..."` automatically.
  - **True threaded replies** (`reply_parameters.message_id` on Telegram, `thread_ts` on Slack, `message_reference` on Discord).
  - **1-Tap Telegram `👍` reaction ack** (`setMessageReaction`).
  - **Live typing & recording presence** (`sendChatAction('typing' | 'record_voice')`).
  - **Bot diagnostics & 409 webhook auto-recovery** (`/api/telegram/verify` + automatic `deleteWebhook` recovery + `/start` onboarding reply).
- **Sub-Second Triage + Prefetched Thread-Aware AI Drafts:** Server-side single-flight polling + SSE push (`/api/stream`), 600ms dwell prefetch cache with last-3-message chat context, instant rule drafts upgraded silently to AI drafts, plus `All / Unread / Telegram Only` filters and `[DONE]` badges.
- **G2 Mic + Browser Mic Voice Pipeline:** Live ASCII VU amplitude meter (`[|||||.....] 4s/15s`), 15s cap, 0.3s min-length anti-hallucination guard, plus real browser `getUserMedia` mic test in Companion UI.
- **Hardened Safety & G2 Engineering:**
  - Locked `activeMessage` snapshot prevents background arrivals from swapping recipients mid-reply.
  - Server-issued single-use 8-second `armToken` (`/api/reply/arm` -> `/api/reply/send`) + localhost-locked CORS + `sessionStorage`-only browser secrets + token redaction in error strings.
  - Strict LVGL-safe ASCII rendering (`sanitizeForG2`), newline-preserving wrapping, coalesced BLE upgrade queue, and in-app double-tap back on sub-menus.

## Quick Setup (Node 22.6+ / Node 24)
```bash
npm install
npm run dev
# Launch official Even Hub Simulator in a second terminal:
npm run simulate
# Standalone local relay (for physical G2 sideloading):
npm run relay
# Typecheck frontend + server, build, and stamp .ehpk:
npm run pack
```
30-second Telegram setup: message `@BotFather` -> `/newbot` -> paste token into `.env.local` or Companion panel -> click **Verify Bot** -> message your bot (text or voice note!).
