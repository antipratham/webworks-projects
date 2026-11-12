---
id: menu-reviews-events
title: AI menu, reviews, events, aggregators, insights and API
topic: feature
visibility: public
sensitivity: normal
source_urls:
  - https://eatlabs.io/features
  - https://eatlabs.io/
scraped: 2026-10-27
---

## AI menu and QR dining

> Spoken: A QR menu at the table with no app to download, in English, Hindi and Kannada, with diet filters and an AI food concierge.

- Table QR menu, **no app to download**, in English, Hindi and Kannada.
- **Diet filters:** veg, vegan, Jain, no dairy, gluten-free, no nuts, mild — using the Indian veg/non-veg dot convention.
- **Badges:** "Most ordered this week", bestseller, trending, chef's special.
- **Shared table sessions:** everyone at the table orders from their own phone, staff can order for guests without one, and the table gets one bill and one payment.
- **Menu import** from a Petpooja, Posist or other POS export, with AI translation into Hindi and Kannada.

## The AI food concierge and allergens

> Spoken: Guests can ask for something like "not spicy, veg, under four hundred rupees". Diet and allergy rules are checked in code, not left to the AI — and if the kitchen hasn't confirmed a dish's allergens, it's never suggested to someone avoiding that allergen.

Guests can ask the concierge things like "something not spicy, veg, under ₹400".

**Dietary and allergy rules are checked in code on every suggestion** — not left to the model. Dishes whose allergens the kitchen has not confirmed are never suggested to guests avoiding that allergen.

Important limit, stated in the Terms: allergen information comes from the restaurant or its POS, EatLabs does not verify it, and the concierge is **guidance for a diner, not a clinical assurance**. The guest web app tells diners to raise allergies with staff. Keeping allergen data accurate is the restaurant's responsibility.

## Reviews and feedback

> Spoken: Google reviews sync every 15 minutes, the AI drafts a reply in your brand voice and in the reviewer's language, and you approve it before it publishes. Low scores come to you privately first.

- **Google reviews synced every 15 minutes**; Zomato reviews imported.
- **AI tagging** of each review by food, service, ambience, price and hygiene.
- **AI-drafted replies** in the restaurant's brand voice and in the reviewer's language. The restaurant **approves and publishes** them — they do not go out automatically.
- **Post-visit feedback request on WhatsApp** after every meal, in EN / HI / KN. Happy guests are asked to review publicly; unhappy ones reach the restaurant first.
- **Low scores go to the owner privately and immediately**, so the guest can be recovered.
- Feedback is linked to the table, server and dish.
- **Weekly digest every Monday** — e.g. "Service complaints up 33%, mostly Friday. Adjust the Friday roster."

## Events and ticketing

> Spoken: Ticketed events, one-off or weekly, with UPI payment, e-tickets on WhatsApp and QR check-in at the door. Tables are blocked automatically so events never clash with bookings.

- Ticketed events, one-off or weekly, using the full venue, part of it, or shared seating.
- **Add-ons** such as drinks packages and table upgrades.
- **UPI payment and e-tickets on WhatsApp.**
- **QR check-in** and walk-up sales at the door.
- Automatic **GST invoices** and payout statements.
- **Tables are blocked automatically** so events and bookings never clash.
- Group-level events can run across outlets with ticket revenue settled per outlet.

## Zomato and Swiggy data

> Spoken: Aggregator bookings come into your agenda with duplicates detected, and a leakage report shows what commission, fees and discounts are actually costing you.

- Import aggregator reservations and payments.
- Aggregator bookings appear in the restaurant's agenda, with **duplicates detected**.
- **Channel split:** walk-in, direct, corporate, event, aggregator.
- **Leakage report:** what the restaurant really pays in commission, fees and discounts it funds.
- Loyalty and WhatsApp campaigns to win aggregator guests back to direct booking.

## Insights

> Spoken: A scoreboard of covers, bookings by source, no-show rate, calls answered, and new versus returning guests — plus a weekly AI summary of the business.

Scoreboard metrics: covers, bookings by source, no-show rate, calls answered (and what share the AI handled), new vs returning guests.

- **Dishes:** most ordered, highest margin, rising.
- **Operations:** table turns, dining time, shift performance, busy-hours heatmap.
- **Revenue by source** and campaign ROI.
- **Weekly AI summary** of the business.

## Business suite

> Spoken: Instagram and Facebook ad performance tied to real bookings and revenue, plus your Google Business Profile stats and website analytics in the same place.

- Instagram and Facebook ad performance, with real bookings and revenue linked to each campaign.
- Google Business Profile stats: views, calls, directions, search keywords.
- Google Analytics for the restaurant's website.
- **Social Canvas:** plan and publish posts to Instagram and Facebook.

## Multi-outlet and staff app

> Spoken: Run the whole group from one account, with roles per outlet. Hosts and managers get a mobile app that keeps working offline.

**Multi-outlet:**

- Role-based access: owner, outlet manager, host, marketing, read-only. Staff only see the outlets they are assigned to.
- Shared across the group: guests and loyalty.
- Set per outlet: phone numbers, floor plans, menus, hours.
- Group events across several outlets, and offers that promote a sister outlet.

**Staff app:** mobile app for hosts and managers covering agenda, walk-ins, the floor and calls. It keeps working **offline** and syncs when back online. Same roles and outlet permissions as the dashboard. One-tap call back, walk-in seating and waitlist from the phone.

## Public API

> Spoken: There's a REST API with webhooks, sandbox keys and an OpenAPI spec, covering availability, bookings, guests, points and bills.

Build on the same data EatLabs runs on — availability, bookings, guests, points and bills.

- **REST + webhooks.** Example events: `booking.created`, `bill.closed`, `review.received`.
- **Sandbox and live keys** — test safely, go live in one click.
- **Scopes per outlet** — read-only or full access per key.
- **OpenAPI spec** — generate a client in any language.
- Rate limits that grow with the group.

Example endpoint shown on the site: `POST /v1/bookings` against `api.eatlabs.io`, returning a created booking with id, table, status and deposit.
