---
id: ai-calls
title: AI calls and phone host
topic: feature
visibility: public
sensitivity: normal
source_urls:
  - https://eatlabs.io/features
  - https://eatlabs.io/
  - https://eatlabs.io/legal/terms
scraped: 2026-10-27
---

## What the AI phone host does

> Spoken: When nobody picks up, or you're closed, the AI answers, checks what's actually free, books the table and sends the confirmation on WhatsApp.

Each outlet gets a dedicated number. Calls ring the restaurant's staff first — one by one or all at once, with up to **six phones per outlet** and rotas by shift.

The AI steps in when nobody picks up, or outside opening hours. It checks live availability and books the table, then the confirmation goes out on WhatsApp.

The headline benefit claimed: a restaurant that "used to miss 30–40 calls every Saturday" now has the AI pick up, book the table, and land the confirmation on WhatsApp before the guest hangs up.

## Warm transfer to staff

> Spoken: If a guest needs a person, staff hear a short summary before the call is connected. If nobody answers, a callback is logged automatically.

**Warm transfer:** staff hear a short summary of the call before it is connected to them. If nobody answers, a callback is logged.

## Missed-call recovery

> Spoken: Any call that still gets missed automatically gets a WhatsApp message back with a booking link that already has their number filled in.

If a call is missed, the guest automatically receives a WhatsApp message containing a booking link with their number already filled in.

## The calls screen

> Spoken: There's one calls screen showing today's calls, missed ones, what the AI handled, and callbacks that are due — with one-tap call back.

The calls screen has four live views: **Today**, **Missed**, **AI-handled**, and **Callbacks due**, updated live, with one-tap call back.

Each row shows the caller, time, how it was handled (AI host / missed / warm transfer / callback due), the outcome and the linked booking. Example states: "AI host · booked T12 · 0:42", "missed · WhatsApp link sent", "warm transfer to Meera · 2:10", "callback due 7:30 pm".

## Call records, recording and transcripts

> Spoken: Calls are recorded only if you turn it on, and callers are told. Recordings are kept 90 days by default, and sensitive numbers are stripped out of transcripts before they're stored.

- Call records hold the transcript, intent, outcome and the linked booking.
- **Recording is per outlet and optional.** If a restaurant switches recording on, the platform announces it to the caller before the conversation starts. Restaurants must not disable, talk over or work around that announcement.
- **Recordings are retained 90 days by default**; a plan can set it lower. Playing a recording needs a specific permission, narrower than the one that lets staff see the call log.
- **Transcripts are redacted before storage** — card numbers, Aadhaar-like identifiers and spoken codes are removed. Redaction is automated and is not warranted to catch everything a caller volunteers.

## What the AI host is allowed to do

> Spoken: The AI can check availability and take or change the caller's own booking. It cannot cancel someone else's booking or issue a refund — those controls simply aren't connected to it.

The AI host's powers are deliberately narrow. It can:

- check availability
- take a booking
- change the caller's **own** booking

It **cannot** cancel or alter another guest's booking, issue a refund, or reach any destructive function. Those tools are not exposed to it at all, whatever a caller says to it.

This is an architectural limit, not a prompt instruction — a useful answer to anyone asking about prompt injection or abuse on the phone line.

## Answering modes and turning AI off

> Spoken: Answering mode is set per outlet. You can run hunt-group only, a normal IVR, or AI answering — and recording, AI replies and the bot each switch off independently.

Answering mode is configurable per outlet: hunt-group only, IVR, or AI answering. Recording, AI replies and the WhatsApp bot can each be turned off independently.

## Phone numbers

> Spoken: We can give you a number, or you can port or point your existing one at the platform.

- Numbers provisioned by EatLabs are allocated under its telecom providers' terms and are subject to their KYC. A number stays allocated while the subscription is active.
- A restaurant may **port or point its existing number** at the platform. Porting timelines are the carrier's.
- Outbound calling features are for the restaurant's own guests and staff. Autodialling and telemarketing campaigns are prohibited.

Call carriage and recording run through **Plivo / Exotel** (processed in India). Real-time speech for the AI phone host runs on **OpenAI** (processed outside India).
