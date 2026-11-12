---
id: security
title: Security, privacy, compliance and data residency
topic: trust
visibility: public
sensitivity: high
source_urls:
  - https://eatlabs.io/security
  - https://eatlabs.io/legal/privacy
  - https://eatlabs.io/legal/terms
scraped: 2026-10-27
---

## Where data lives

> Spoken: All guest and account data is stored in India, in the AWS Mumbai region, and it's designed for the DPDP Act. There's no cross-region replication of personal data.

Guest Data and restaurant account data are stored **in India, in the AWS Mumbai region (ap-south-1)**, designed for the **Digital Personal Data Protection Act, 2023 (DPDP Act)**. There is **no cross-region replication of personal data**.

Trade-off stated openly in the Terms: the platform runs in **one AWS region in India**. That is a deliberate data-residency choice, and it means a regional failure can take the service down. Floor staff should be able to work from a printed agenda for a service if they have to.

## What processing happens outside India

> Spoken: Only three things leave India — the AI model inference, WhatsApp delivery through Meta, and reading back your own Google and Meta business stats.

Exactly three categories of processing happen outside India:

1. **Model inference for AI features** — the conversation text, sent to the provider and returned.
2. **WhatsApp message delivery** through Meta's Cloud API, carrying the recipient's number and message content, as it must to deliver.
3. **Google and Meta business data read back** for the business suite — page insights, review content, ad performance.

These transfers are made under contract, to countries not restricted by the Central Government under section 16 of the DPDP Act. EatLabs will stop a transfer that becomes restricted.

## The security measures

> Spoken: Role-based access across around 290 API routes, checked automatically on every release. All connected-account keys are encrypted, and every refund, point change and review reply is logged with who did it and when.

Published measures:

- **Data stored in India** (AWS Mumbai), designed for the DPDP Act.
- **EatLabs never sees card or UPI details.** Payments run on Razorpay; each restaurant settles directly to its own account.
- **Role-based access across roughly 290 API routes**, checked automatically on every release.
- **Encryption** of all connected-account keys and tokens.
- **Full audit trail** — every refund, point change and review reply logged with who did it and when.
- **Consent respected at every send**; guests can opt out at any time.
- **Guest data is never shared between restaurants**, including in cross-brand promotions — partners reach each other's guests without either side seeing the other's data.

## Tenant isolation

> Spoken: One restaurant's guest data is never visible to another, and that's enforced at the database level, not by convention.

EatLabs never makes one customer's Guest Data visible to another. **This is enforced at the database level, not by convention.** Cross-brand promotions let partners reach each other's guests without either side seeing the other's data.

## Staff access to customer data

> Spoken: Our staff don't browse your data. Support access needs a time-boxed session with a stated reason and a ticket reference, every record read is logged, and the account owner is notified.

EatLabs staff do not browse customer data. Support access requires a **time-boxed session opened with a stated reason and a ticket reference**; every record read in it is logged to a **tamper-evident log**, and the **account Owner is notified**.

## Data Fiduciary vs Data Processor

> Spoken: For guest data you are the Data Fiduciary and we are your processor — you decide what's collected and why, we process it on your instructions.

For **Guest Data**: the restaurant is the **Data Fiduciary**, EatLabs is the **Data Processor**. The restaurant decides what is collected and why; EatLabs processes it on the restaurant's instructions to deliver the platform.

For **account data** — staff names and logins, billing details, support correspondence — EatLabs is the Data Fiduciary in its own right.

EatLabs' processor commitments:

- Processes Guest Data only to provide and support the platform, meet a legal obligation, or on documented instruction. **Does not sell it. Does not use it to advertise to the restaurant's guests.**
- Holds data processing agreements with every sub-processor.
- Will help answer a guest's rights request and will act on an erasure instruction across every store **within seven days**.
- Will notify the restaurant of a personal data breach without undue delay.

## Sub-processors

> Spoken: We use AWS for hosting in Mumbai, Razorpay for payments, Plivo and Exotel for calls — all in India — plus Meta, OpenAI, Anthropic and Google, which process outside India.

| Sub-processor | What it does | Where it processes |
|---|---|---|
| Amazon Web Services | Hosting, database, object storage, SMS delivery | India (Mumbai, ap-south-1) |
| Meta Platforms | WhatsApp Cloud API; Facebook and Instagram publishing | Outside India |
| Razorpay | Payment links and settlement, on the restaurant's own merchant account | India |
| Plivo / Exotel | Inbound and outbound call carriage, call recording | India |
| OpenAI | Real-time speech for the AI phone host | Outside India |
| Anthropic | Language models behind the agent, replies and AI Studio | Outside India |
| Google | Business Profile and review data, Analytics, Maps | Outside India |
| *(email provider — unnamed on the published page)* | Transactional email | *(unspecified)* |

## Payments: money never passes through EatLabs

> Spoken: Money doesn't pass through us. You connect your own Razorpay account, guests pay on Razorpay's hosted page, and it settles straight to your bank.

- Each restaurant connects **its own Razorpay merchant account**, with its own KYC. Guest payments settle **directly to the restaurant's bank account**.
- **Card numbers, CVVs, UPI handles and bank credentials never reach EatLabs.** Guests pay on Razorpay's hosted page. EatLabs keeps only the payment id, amount, method and status.
- Amounts are always computed by the server from the restaurant's rules. A client never sends a price.
- A refund needs a reason and a permission, and is recorded in an **append-only ledger**.
- Razorpay keys and webhook secrets are encrypted at rest and are **never returned by the API**.
- EatLabs is **not a payment system operator** and does not hold, pool or remit funds. Disputes, chargebacks and settlement timing are between the restaurant, the guest and Razorpay.

## Retention periods

> Spoken: Call recordings and transcripts, 90 days by default. Bookings, two years then personal fields are stripped. Tax records, eight years, as GST requires.

| Record | Retention |
|---|---|
| Guest profile | Until erasure requested, or the restaurant leaves |
| Bookings | 2 years, then personal fields stripped |
| Call recordings | 90 days by default; a plan can set it lower |
| Call transcripts and metadata | 90 days by default |
| Message delivery records | 1 year; recipient number removed on erasure |
| Inbound provider webhooks | 30 days |
| Audit log | 13 months live, archived to 2 years |
| Security event records | 90 days live, 1 year archived |
| Application logs | 30 days live, archived to 1 year, as CERT-In requires |
| Payment, ticket and tax records | 8 years, as GST record-keeping requires |
| Erasure request records (no personal data) | Kept, to prove an erasure happened |
| Restaurant account after termination | Live data deleted at 60 days; backups age out by 90 days |

Retention is enforced by a **scheduled job, not by good intentions**.

## Breach notification

> Spoken: We assess any breach within 24 hours and notify the Data Protection Board and affected people where the DPDP Act requires it.

A personal data breach is assessed **within 24 hours**. Where the DPDP Act requires it, EatLabs notifies the Data Protection Board of India and the affected Data Principals, with what happened, what data was involved and what to do about it. If the breach touches a restaurant's Guest Data, that restaurant is notified without undue delay.

## Availability and support commitments

> Spoken: We don't publish a general uptime percentage — if you need a committed figure, it goes in your order form. Support is by WhatsApp, phone and email, with priority for an outlet that can't take bookings at all.

- EatLabs **does not publish a general availability percentage**. Where a customer needs a committed figure, with measurement method and remedy, it goes in their **order form**.
- Support is by WhatsApp, phone and email, with **priority handling for an outlet that cannot take bookings at all**.
- Planned maintenance is announced in the dashboard, scheduled outside Indian restaurant service hours where possible.
- Without an order-form availability commitment and service credits, the remedy for unavailability is the right to terminate for sustained and material failure.

## Compliance documents

> Spoken: We can share a data-processing summary and a DPIA — ask for them on the demo call.

A **data-processing summary and DPIA** are available on request — the site directs people to ask for them on the demo call.

## Governing law

> Spoken: Indian law, with the courts at Bengaluru having exclusive jurisdiction.

The agreement is governed by the laws of India. The courts at **Bengaluru, Karnataka** have exclusive jurisdiction. Before filing, each side gives the other 30 days to resolve the dispute through senior representatives.
