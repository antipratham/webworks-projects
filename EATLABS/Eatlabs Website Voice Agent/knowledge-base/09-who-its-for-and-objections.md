---
id: segments-objections
title: Who it's for, integrations and common objections
topic: sales
visibility: public
sensitivity: normal
source_urls:
  - https://eatlabs.io/who-its-for
  - https://eatlabs.io/faq
  - https://eatlabs.io/features
scraped: 2026-10-27
---

## Segment 1 — Busy single restaurants

> Spoken: If your phone rings during service and nobody can pick up, EatLabs answers, books the table and tells your host what happened.

For busy single restaurants that **lose bookings to unanswered phones**.

The problem: the phone rings during service and nobody can pick up.

- AI host answers when staff can't, 24×7
- Missed-call recovery on WhatsApp
- One live agenda for phone, WhatsApp and walk-ins
- **Live in a day, no code needed**

## Segment 2 — Restaurant groups

> Spoken: A guest who eats at Indiranagar should be recognised in Koramangala. One profile per guest, one points balance, across every outlet.

Yes, EatLabs supports **multiple outlets**. This is for groups that want **one guest
database and one loyalty programme** across all of them.

- One guest record across all outlets
- Group-wide points, tiers and rewards
- Per-outlet numbers, floor plans, menus and hours
- Roles: owner, outlet manager, host, marketing, read-only

Published quote: "Three outlets, one guest list. When a regular from Koramangala walks into Whitefield, the host already knows her table preference." — Rohan Mehta, Co-founder, Byg Brewski

## Segment 3 — Bars and venues

> Spoken: If you run events, gigs and ticketed nights — sell tickets on WhatsApp, check guests in by QR, and never double-book a table an event already holds.

For bars and venues that run **events, gigs and ticketed nights**.

- Ticketed events, one-off or weekly
- UPI payment, e-tickets and QR check-in at the door
- Add-ons: drinks packages, table upgrades
- Tables blocked automatically — no clashes with bookings

## Segment 4 — Restaurants on Zomato and Swiggy

> Spoken: Aggregator guests become your guests. Import their bookings, see what commission really costs you, and bring them back direct.

For restaurants that want to **own their guest relationships**.

- Aggregator bookings in the agenda, duplicates detected
- Leakage report: commission, fees and discounts the restaurant funds
- Channel split: walk-in, direct, corporate, event, aggregator
- Loyalty and WhatsApp campaigns to win them back direct

## Integrations at a glance

> Spoken: Petpooja, Posist and others through a webhook or CSV import. Payments through your own Razorpay. WhatsApp through Meta. Google and Instagram for reviews and ads.

- **POS:** Petpooja, Posist and others, through a **webhook or a CSV import**. Menu import and live table status come from the POS.
- **Payments:** the restaurant's own Razorpay account. UPI, cards, GST.
- **Messaging:** Meta WhatsApp Cloud API; SMS via AWS; email.
- **Telephony:** Plivo / Exotel. Own number can be ported or pointed.
- **Reviews and listings:** Google Business Profile (synced every 15 min), Zomato review import.
- **Ads and analytics:** Meta Pixel, Google Ads, GA4, GTM, Instagram, Facebook.
- **Aggregators:** Zomato, Swiggy, EazyDiner booking import.
- **Own systems:** public REST API with webhooks, sandbox keys, per-outlet scopes and an OpenAPI spec.

## Objection: "Will the AI replace my staff?"

> Spoken: No. Your team answers first. The AI only covers missed calls, peak hours and the times you're closed.

No. The team answers first, and the AI covers missed calls, peak hours and closed hours. Answering mode is configurable per outlet, and the AI can be switched off entirely.

Reframe: it is not a replacement for a host, it is cover for the calls that currently go unanswered during service.

## Objection: "Do my guests need to download an app?"

> Spoken: No. Booking, the menu, the waitlist and tickets all open in the browser.

No. Booking, the menu, the waitlist and tickets all open in the browser.

## Objection: "Can the AI get it wrong?"

> Spoken: Yes, it can — it's a language model, so you should review anything that goes out in your name. That's why review replies are drafted for your approval rather than published automatically.

Stated plainly in the Terms: model output is generated, not retrieved from a rulebook, and it **can be wrong**. Restaurants should review anything that goes out in their name, especially review replies and campaign copy.

The mitigations built in:

- AI review replies are **drafted for approval**, not auto-published.
- The AI host's powers are architecturally narrow — it cannot touch another guest's booking, issue refunds, or reach destructive functions.
- Diet and allergy rules in the menu concierge are **checked in code**, not left to the model.
- Everything metered and consequential is logged in an audit trail.

## Objection: "What if my internet or the service goes down?"

> Spoken: The staff app keeps working offline and syncs when you're back. And we'd tell you honestly — we run in one Indian region, so you should be able to fall back to a printed agenda for a service.

- The **staff app keeps working offline** and syncs when back online.
- EatLabs runs in **one AWS region in India** — a deliberate data-residency choice that means a regional failure can take the service down. The Terms advise that floor staff should be able to work from a printed agenda for a service if they have to.
- Priority support for an outlet that cannot take bookings at all.
- Bookings already taken are never cancelled by a credit balance running out.

## Objection: "How fast can we go live?"

> Spoken: A single restaurant can be live in a day, with no code needed, and the trial is set up with our onboarding team.

The site claims a busy single restaurant can be **live in a day, no code needed**. The free trial includes set-up with the onboarding team and the restaurant's own number on the AI voice receptionist.

## What owners say

> Spoken: One owner said they used to miss 30 to 40 calls every Saturday, and now the AI books the table before the guest hangs up.

- "We used to miss 30–40 calls every Saturday. Now the AI picks up, books the table and the confirmation lands on WhatsApp before the guest hangs up." — **Rohit Nair, Owner, Café Nova · Indiranagar**
- "Deposits for 8+ guests cut our weekend no-shows from about 18% to under 5%. Guests don't mind — they just pay on UPI and show up." — **Shreya Kulkarni, GM, The Permit Room · Church Street**
- "Three outlets, one guest list. When a regular from Koramangala walks into Whitefield, the host already knows her table preference." — **Rohan Mehta, Co-founder, Byg Brewski**
