<!-- source: https://eatlabs.io/legal/privacy -->
<!-- fetched: 2026-11-02T11:57:57+0530 -->

Skip to content
[image: EatLabs]
HomeFeaturesPricingTestimonialsContact
Sign inGet a free demo
Get Demo
[button] Open menu
[image: EatLabs]
[button] Close menu
HomeFeaturesPricingTestimonialsContact
Get a free demoSign in
WhatsApp us · +91 80 4000 1200A person replies, 9 am – 9 pm
LanguageEnglishहिन्दीಕನ್ನಡ
LEGAL

## Privacy Policy

What personal data EatLabs holds, why, where it lives, how long it stays, and the rights you have over it. Written to the Digital Personal Data Protection Act, 2023.
Effective
5 October 2026
Written for
Restaurants, their staff, and visitors to this site

### On this page

- 1. Scope, and our two different roles
- 2. What we collect
- 3. Why we process it, and on what basis
- 4. AI processing, and what goes to a model provider
- 5. Calls, recordings and transcripts
- 6. Security
- 7. Who else processes the data
- 8. Where data lives, and the transfers out of India
- 9. Payments
- 10. How long we keep things
- 11. Your rights
- 12. Breach notification
- 13. Children
- 14. Cookies and analytics on this website
- 15. Changes to this policy
- 16. Contact and grievances

### 1.Scope, and our two different roles

This policy covers personal data handled by CHEVALBLEU LABS (OPC) PRIVATE LIMITED (CIN [CIN]), trading as EatLabs, across eatlabs.io, the restaurant dashboard at app.eatlabs.io, the guest web app at book.eatlabs.io, our API, and the phone, WhatsApp and SMS channels we operate for restaurants.
EatLabs sits in two different positions, and your rights differ depending on which one applies:
| Whose data
| Our role
| What that means
| A restaurant’s account, its staff logins, its billing
| Data Fiduciary
| We decide the purposes. Bring your requests to us
| A diner’s data, held for a restaurant
| Data Processor
| The restaurant decides the purposes. We act on its instructions
| A visitor to eatlabs.io
| Data Fiduciary
| We decide the purposes
If you are a diner, read the Guest Privacy Notice instead — it is written for you, and it explains the restaurant’s role as well as ours.

### 2.What we collect

#### 2.1 From restaurants and their staff

| Data
| Why we have it
| Name, work email, mobile number, role, outlet assignment
| To create and secure a login, and apply permissions
| Password hash, device and session records, login and IP history
| Authentication, new-device alerts, abuse detection
| Business name, address, GSTIN, PAN where required, bank reference
| Contracting, invoicing, tax compliance
| Billing and Credit history, plan changes
| To bill you and show you your usage
| Support messages, call notes, demo requests
| To answer you, and to improve the product
| Actions taken in the dashboard — who changed what, and when
| The audit trail you may need to rely on
| Connected-account tokens for Meta, Google, Razorpay and your POS
| To post, read insights and take payments as you asked

#### 2.2 Guest Data, processed for a restaurant

When a diner books, calls, scans a QR menu, joins a waitlist, buys an event ticket, pays a deposit or replies to a message, we process on the restaurant’s behalf: name, phone number, email, party size, dietary and allergy notes, occasion, booking and visit history, bill totals from the POS, loyalty balances, tickets, message history, consent records, and — where the outlet has it switched on — call recordings and transcripts.
We hold this because a restaurant asked us to. We do not decide what it is used for and we do not use it for our own purposes. Section 1 of the Guest Privacy Notice sets it out in the diner’s own terms.

#### 2.3 From visitors to this website

Page requests, referrer, approximate location from IP, device and browser, and what you type into a demo or contact form. We use Google Analytics 4 for aggregate traffic measurement. See section 7.

### 3.Why we process it, and on what basis

| Purpose
| Basis under the DPDP Act
| Running the Platform for a subscribing restaurant
| Performance of our contract with that restaurant
| Creating and securing staff logins
| Contract, and our legitimate use in keeping it secure
| Billing, invoicing, tax and statutory record-keeping
| Legal obligation
| Fraud prevention, abuse detection, incident investigation
| Legitimate use; compliance with law
| Answering support requests
| Contract
| Sending diners transactional messages about their own booking
| The restaurant’s instruction, on the diner’s interaction
| Sending diners marketing
| The diner’s consent, recorded per purpose
| Product analytics in aggregate, and improving the service
| Legitimate use; data is aggregated and not identifying
| Telling you about changes to the Platform or these terms
| Contract; legal obligation
We do not sell personal data. We do not share it with advertising networks. We do not use Guest Data to train models for our own benefit or anyone else’s.

### 4.AI processing, and what goes to a model provider

The AI phone host, the WhatsApp bot, the menu concierge, AI review replies and AI Studio send text to a large language model provider to generate a response. You should know exactly what travels.
- What is sent: the conversation itself, plus the narrow operational context the answer needs — the outlet’s opening hours, its knowledge entries, availability for the dates discussed, and the caller’s own booking where there is one.
- What is not sent: your guest list, another guest’s records, bill history, payment credentials, staff logins or anything from another restaurant’s account.
- Call transcripts are redacted before storage. Card numbers, Aadhaar-like identifiers and spoken codes are stripped out automatically.
- Guest speech is handled as data, not as instruction. The model’s available actions are a fixed list, each one checked server-side against the call’s restaurant and outlet. Destructive actions are not available to it at all.
- We contract for no training and no retention. Our agreements with model providers permit them to process a request and return a response, and nothing else: we do not permit your content to be used to train their models, and we require the shortest retention each provider offers. Where a provider cannot offer those terms for a feature, we do not route your content to it.
- Our current model providers are listed in section 7, and some of their inference runs outside India. Section 8 explains that transfer.

### 5.Calls, recordings and transcripts

- Recording is off unless the restaurant turns it on for an outlet, and the Platform announces recording to the caller before the conversation begins.
- Recordings are fetched once from the carrier, stored in our own encrypted storage in India, and the carrier’s copy is deleted.
- Listening to a recording requires a specific permission, narrower than the one that lets staff see the call log. Audio streams directly from storage over a short-lived signed URL and never passes through a general-purpose interface.
- Recordings are deleted after the retention period on the restaurant’s plan — 90 days by default. Transcripts and call metadata are kept for 90 days by default.

### 6.Security

| Control
| What it is
| Isolation between restaurants
| Enforced in the database itself, plus two independent application layers
| Encryption
| TLS in transit; encrypted at rest; connected-account keys sealed separately
| Passwords
| Argon2id hashing, breach-list checks, rate limiting, optional MFA
| Access control
| Role-based permissions on every API route, verified automatically each release
| Audit trail
| Every refund, point change, permission change and reply logged with actor and time
| Our own staff
| No standing access to your data. Support opens a time-boxed session with a stated reason and ticket; every read is logged to a tamper-evident store; the account Owner is notified
| Secrets
| Held in a managed secret store, never in code; automated scanning blocks commits
| Payments
| Card and UPI details never reach us — see section 9
No system is perfectly secure. If something goes wrong, section 12 says what we do.

### 7.Who else processes the data

We use the following sub-processors. Each is under a data processing agreement, and the list is kept current here.
| Sub-processor
| What it does for us
| Where it processes
| Amazon Web Services
| Hosting, database, object storage, SMS delivery
| India (Mumbai, ap-south-1)
| Meta Platforms
| WhatsApp Cloud API; Facebook and Instagram publishing
| Outside India
| Razorpay
| Payment links and settlement, on the restaurant’s own merchant account
| India
| Plivo / Exotel
| Inbound and outbound call carriage, call recording
| India
| OpenAI
| Real-time speech for the AI phone host
| Outside India
| Anthropic
| Language models behind the agent, replies and AI Studio
| Outside India
| Google
| Business Profile and review data, Analytics, Maps
| Outside India
| [EMAIL PROVIDER]
| Transactional email
| [REGION]
We also disclose personal data where the law requires it — to a court, a regulator or a law enforcement agency acting under lawful authority. Where we are permitted to tell the affected person or restaurant, we will.
If we are ever part of a merger, acquisition or sale of assets, personal data may transfer to the buyer. It stays subject to a policy no less protective than this one, and we will say so in advance.

### 8.Where data lives, and the transfers out of India

Guest Data and restaurant account data are stored in India, in the AWS Mumbai region. There is no cross-region replication of personal data.
Three categories of processing happen outside India, and only these:
1. Model inference for the AI features — the conversation text in section 4, sent to the provider and returned. 2. WhatsApp message delivery through Meta’s Cloud API, which carries the recipient’s number and the message content, as it must to deliver it. 3. Google and Meta business data read back for the business suite — your page insights, review content, ad performance.
These transfers are made under contract with each provider, to countries not restricted by the Central Government under section 16 of the DPDP Act. We will stop a transfer that becomes restricted.

### 9.Payments

Each restaurant uses its own Razorpay merchant account. Diners pay on Razorpay’s hosted page.
Card numbers, CVVs, UPI handles and bank credentials never reach EatLabs. We store the payment identifier, the amount, the method and the status — enough to confirm a deposit, reconcile a bill and process a refund, and nothing more. Money settles from Razorpay to the restaurant’s own bank account; it does not pass through us.

### 10.How long we keep things

| Record
| Retention
| Guest profile
| Until erasure is requested, or the restaurant leaves
| Bookings
| 2 years, then the personal fields are stripped
| Call recordings
| 90 days by default; the plan can set it lower
| Call transcripts and call metadata
| 90 days by default
| Message delivery records
| 1 year; recipient number removed on erasure
| Inbound provider webhooks (carry numbers and message bodies)
| 30 days
| Audit log
| 13 months live, archived to 2 years
| Security event records
| 90 days live, 1 year archived
| Application logs
| 30 days live, archived to 1 year, as CERT-In requires
| Payment, ticket and tax records
| 8 years, as GST record-keeping requires
| Erasure request records (no personal data in them)
| Kept, so we can prove an erasure happened
| Restaurant account after termination
| Live data deleted at 60 days; backups age out by 90 days
Retention is enforced by a scheduled job, not by good intentions. Where a record must be kept for tax or audit reasons after an erasure request, we strip everything not legally required and keep a note of the basis for the rest.

### 11.Your rights

Under the DPDP Act you may:
- Access — get a copy of your personal data and a summary of how it is processed. Restaurants can export theirs from the dashboard at any time; diners can ask for an export.
- Correct — have inaccurate or incomplete data fixed, and have outdated data updated.
- Erase — have your personal data deleted where it is no longer needed for the purpose it was collected for, and where no law requires us to keep it.
- Withdraw consent — for anything consent-based, such as marketing. One tap in any marketing message, or ask us. Withdrawal reaches every channel immediately.
- Nominate — name someone to exercise your rights if you die or become incapacitated.
- Complain — to our Grievance Officer, and then to the Data Protection Board of India.
How to exercise them: the data deletion and rights page has the exact steps, what to include, and how long each takes. In short — write to privacy@eatlabs.io.
If your data is held for a restaurant, we will route your request to that restaurant and act on its instruction, and we will tell you we have done so. We verify identity before acting on a request, usually with a one-time code to the number on file. That is a protection for you: an unverified deletion request is how one person erases another person’s bookings.
We acknowledge within 72 hours and complete within 7 days for an erasure, or 30 days for anything that needs a restaurant’s involvement.

### 12.Breach notification

If a personal data breach occurs, we assess it within 24 hours and, where the DPDP Act requires it, notify the Data Protection Board of India and the affected Data Principals, with what happened, what data was involved, and what to do about it. If the breach touches a restaurant’s Guest Data, we notify that restaurant without undue delay so it can meet its own obligations.

### 13.Children

The dashboard is for restaurant staff and is not intended for anyone under 18. We do not knowingly create accounts for children.
A restaurant must not use the Platform to collect personal data about a child for tracking, behavioural monitoring or targeted advertising, and must have verifiable parental consent where the DPDP Act requires it. If you believe we hold a child’s data without that consent, write to privacy@eatlabs.io and we will delete it.

### 14.Cookies and analytics on this website

This site uses only what it needs: a session cookie for a form you are filling in, and Google Analytics 4 for aggregate traffic measurement. We do not run advertising or cross-site tracking cookies here. Your browser’s own controls will block or clear all of them, and the site still works.
The dashboard and the guest app use a strictly necessary cookie to keep you signed in. There is no way to use them without it.

### 15.Changes to this policy

We will post a revised version here with a new effective date. For a change that materially affects how we handle personal data, we will notify restaurant account Owners at least 30 days in advance. Previous versions are available on request.

### 16.Contact and grievances

| For
| Where
| Privacy questions and requests
| privacy@eatlabs.io
| Grievance Officer
| [GRIEVANCE OFFICER NAME] · grievance@eatlabs.io · +91 80 4000 1200
| Security reports
| security@eatlabs.io
| Post
| CHEVALBLEU LABS (OPC) PRIVATE LIMITED, [REGISTERED OFFICE ADDRESS], Bengaluru, Karnataka, India
We will respond to a grievance within 30 days. If you are not satisfied, you may complain to the Data Protection Board of India.

### Questions about this page?

Write to privacy@eatlabs.io, or talk to us on +91 80 4000 1200. A person replies.

### The rest of the legal pages

- Terms of Service
For restaurants on EatLabs: subscription, credits, responsibilities and termination.
- Guest Privacy Notice
For diners: what a restaurant holds about you, who can see it and how long it stays.
- Guest Terms of Use
For diners: booking, deposits, the QR menu, the AI host, tickets and loyalty points.
- Delete my data
Raise one support request and we delete your data within seven days. Also access and correction.
[image: EatLabs]
EatLabs is the AI restaurant operating system for Indian dine-in restaurants — calls, WhatsApp, bookings, menu, loyalty and reviews in one place. Built in Bengaluru by WebWorks Co.
[image: Instagram]
[image: Facebook]
[image: LinkedIn]

### Menu

- Home
- Plans
- Guide
- Contact Us
- Bengaluru · +91 80 4000 1200
- hello@eatlabs.io

### Offices

- Bengaluru
Offices · Bengaluru
© 2026 CHEVALBLEU LABS (OPC) PRIVATE LIMITED · EatLabs · Bengaluru, India
- Privacy Policy
- Terms of Service
- Guest Privacy
- Guest Terms
