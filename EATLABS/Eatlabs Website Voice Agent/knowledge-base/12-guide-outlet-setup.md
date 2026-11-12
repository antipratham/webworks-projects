---
id: guide-outlet-setup
title: Setting up an outlet — tables, shifts, booking rules, calls, WhatsApp and deposits
topic: onboarding
visibility: public
sensitivity: normal
source_urls:
  - https://eatlabs.io/guide/open-your-outlet
  - https://eatlabs.io/guide/take-bookings
  - https://eatlabs.io/guide/start-marketing
scraped: 2026-11-02
---

## Opening an outlet — the first 15 minutes

> Spoken: Add the outlet in Settings, Outlets, Add outlet. It takes about 15 minutes and goes live the moment you save, with no approval to wait for.

The first thing to do after signing in. **Nothing else works until it is done.**

Go to **Settings → Outlets → Add outlet**. The form asks for:

- The outlet's name and a short code (for example IND for Indiranagar).
- Its address, and the phone number guests call.
- How many seats it has.
- Its opening hours.
- The people who answer guest calls.
- Where the menu comes from — it can be copied from another outlet.

Only the **address, phone number and seats** are required to open. The map pin is optional.

**Opening hours:** at least one day must be open, because guests can only book times when the restaurant is open. A day can have two windows if the kitchen closes between lunch and dinner.

The outlet is **live as soon as it is saved** — there is no approval step.

**Settings → Settings dashboard** lists every setup step and ticks each one off.

## Tables and areas

> Spoken: Add your areas first, then the tables in each one. With no tables nobody can book, because guests are only offered the seats your tables add up to.

Go to **Reservations → Floor plan → Edit layout**.

- Add **areas** first — main dining, terrace, private room.
- Add the **tables** in each area, with how many seats each has.
- Mark tables that **can be pushed together**, so two tables for four can seat a party of six.

Do this before anything else about bookings. Guests are offered only the seats the tables add up to, so with no tables nobody can book at all.

## Shifts and the booking rules

> Spoken: Add a shift for each service, then check the booking rules. By default guests book up to 60 days ahead, up to 30 minutes before, for parties up to 20, with a 90-minute table.

Go to **Reservations → Settings**. Add a **shift** for each service — at least lunch and dinner — with its days, hours and how long a table is held.

| Rule | What it decides | Starts at |
|---|---|---|
| Guests can book up to | How far ahead a guest may book | 60 days |
| Same-day cut-off | How close to the time a booking is still accepted | 30 minutes |
| Largest party online | Bigger groups booking by web, WhatsApp or the AI host get a call back instead | 20 guests |
| Seating time | How long a table is kept for each booking | 90 minutes |
| Blackout dates | Days the restaurant takes no bookings at all | None |

## Loading the menu

> Spoken: Add dishes one by one, import a file or a POS export, or copy another outlet's menu. Then print a QR code for each table.

Go to **Food Menu**. Dishes can be added one at a time, imported from a file or a POS export, or copied from another outlet's menu. Then print a QR code for each table from **Food Menu → Table QR codes**.

## The AI calling number and the test call

> Spoken: Request your calling number in Settings, Outlets, choose how calls are answered, add a staff mobile to the ring order, then make a test call and answer it.

1. **Request the calling number** from the outlet's page in **Settings → Outlets**. EatLabs assigns it; the dashboard shows "number requested" until then.
2. In **Settings → Calls**, choose how calls are answered: staff first and then the AI host, the AI host alone, or a menu of options.
3. Add **at least one staff mobile** to the ring order, so a call the AI passes on has someone to reach.
4. Make a test call from **AI Calls → Hunt group & routing → Try the AI host**, and answer it.

Until a test call has been answered, the dashboard does not count the phone line as ready.

## WhatsApp and email setup

> Spoken: Three automatic messages need Meta's approval before they can be sent, so submit them early. Until you connect your own number, messages go from the shared EatLabs number.

**Settings → WhatsApp.** Three messages go to guests automatically — the **booking confirmation**, the **booking reminder** and the **missed-call message** — and **Meta must approve each one** before it can be sent.

Submit them early: approval takes minutes to a few hours, and a booking taken before then gets no WhatsApp confirmation.

Until the restaurant connects its own WhatsApp Business number (**Connect with Meta**), messages go out from the shared EatLabs number. That is fine for confirmations, but **campaigns need the restaurant's own number**.

**Settings → Email.** Guests who give an email address also get confirmations, reminders and cancellations by email, from the EatLabs sender until the restaurant connects its own.

## Turning on deposits

> Spoken: Connect Razorpay in Settings, Payments, add both the keys and the webhook address, then write at least one deposit rule. Start in test mode.

Only needed if the restaurant takes deposits.

1. **Connect Razorpay** in **Settings → Payments**. Guests pay the restaurant directly and the money settles to its bank — it never passes through EatLabs. Add the Razorpay **keys first, then the webhook address** the page shows. **Both are needed**, or a guest's payment is never heard about. Start in **test mode**.
2. **Switch deposits on** in **Reservations → Settings → Deposits** and write at least one rule: who pays, how much (per guest or a fixed amount), how long an unpaid booking is held, and the refund policy.

## Connecting Meta and Google for marketing

> Spoken: Connect Meta for campaigns, posts and ads, and Google Business Profile to reply to reviews. Connecting is not enough on its own — you must also pick which Page and account belong to which outlet.

- **Facebook, Instagram and Meta ads.** **Settings → Meta config → Connect with Meta**. Campaigns, social posts, ads and Instagram messages all depend on it. **Connecting is not the last step** — choose which Facebook Page, Instagram account and ad account belong to which outlet, or nothing gets published.
- **Google Business Profile.** Also in **Settings → Meta config**. Needed to reply to Google reviews from EatLabs and to see Google views, calls and searches. Connect it **before** switching on automatic replies in **Reviews → Review settings**.
- **Google Ads and Google Analytics.** Optional, only if already in use. Meta ads work without Google Ads.

None of these affect bookings, so they can wait.

## The setup order, in one list

> Spoken: Address, phone, seats and opening hours get you open. Tables, shifts, a menu and WhatsApp approval are what bookings need. Everything else can follow in any order.

**Needed to open**

- Outlet basics — address, guest phone, seats
- Opening hours — at least one day

**Needed for bookings to work**

- Tables and areas
- Shifts and booking rules
- A menu
- WhatsApp messages sent to Meta for approval

**Then, in any order**

- Manager invited, and accepted
- Calling number requested, ring order filled in, test call answered
- The restaurant's own WhatsApp number and email sender
- Razorpay, if taking deposits or selling event tickets
- Facebook Page, Instagram and ad account, for each outlet
- Google Business Profile, for review replies
- Google Ads and Analytics, if already in use

Getting ready for bookings takes about **an hour**, plus the wait on Meta.
