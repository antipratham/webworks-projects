# Editing the knowledge base

This folder is the agent's entire supply of facts. If an answer on the website agent is
wrong, out of date or missing, the fix is here — not in the model, not in the prompt.

You do not need to understand the retrieval code to change an answer. You need Python and
Node installed, and about two minutes.

---

## The loop

```bash
# 1. edit the markdown
#    e.g. knowledge-base/06-pricing-and-billing.md

# 2. rebuild the index the agent reads
python tools/build_kb.py ./knowledge-base ./kb.jsonl

# 3. check every figure still traces to a source
python tools/audit_kb.py

# 4. check nothing broke
node tests/retrieval_tests.ts

# 5. see it answer
node serve.ts        # http://127.0.0.1:3100
```

**All four must pass before you commit.** Steps 2 and 3 exit non-zero on failure, so they
drop straight into CI.

`kb.jsonl` is generated. Never hand-edit it — step 2 overwrites it.

---

## The one rule

> **Every number in this folder must exist in `source-raw/` or `source-provided/`.**

`tools/audit_kb.py` enforces it and fails the build otherwise. This is the whole point of
the design: the agent quotes prices and legal terms to people who then make decisions, so
a figure that came from nowhere is the worst thing that can happen. There is a second
check at answer time (`src/answer.ts`) that refuses to say a price or percentage it cannot
find in a retrieved passage — so an un-sourced number mostly will not reach a caller even
if it gets committed. Do not rely on that. Fix it here.

If you need to state something the website does not publish:

1. Put the supplied wording verbatim in `source-provided/<name>.md`, with a comment saying
   who gave it to you and when.
2. In the curated file, set `provenance: provided` and list the file under `source_files:`.

`knowledge-base/10-webworksco.md` is the worked example.

---

## File format

Every `##` section becomes one retrievable chunk. Keep them answer-shaped: one question's
worth of fact per section.

```markdown
---
id: pricing                      # chunk ids become  pricing#the-published-plans
title: Pricing, plans and billing
topic: commercial                # grouping only; retrieval does not depend on it
visibility: public               # public | agent-only
sensitivity: high                # normal | high | critical
source_urls:                     # where on the site this came from
  - https://eatlabs.io/#plans
scraped: 2026-10-27
---

## The published plans

> Spoken: There are three plans. A 7-day free trial, Growth at ₹35,000 per month per
> venue, and Enterprise with custom pricing. GST is extra.

| Plan | Price |
|---|---|
| Growth | ₹35,000 / month / venue |
```

### The fields that change behaviour

| Field | Values | What it does |
|---|---|---|
| `visibility` | `public` | Retrievable. Use this unless you mean the other one. |
| | `agent-only` | **Never** returned as a passage. For rules *about* the agent, like `99-guardrails`. An agent that can retrieve "never mention X" will read that sentence out to whoever asked about X. |
| `sensitivity` | `normal` | Ordinary content. |
| | `high` | Prices, legal terms, security, guest rights. Quote exactly; never paraphrase a number. |
| | `critical` | Guardrails. |
| `opening_section` | an exact heading | Names the section that answers "what is this?". Retrieval falls back to it for a greeting or an unsearchable question. **Exactly one file must set it** — the build fails otherwise. |
| `provenance` | `scraped` | Default. Traceable to `source-raw/`. |
| | `provided` | Supplied by the business. Needs `source_files:`. |

`visibility` and `sensitivity` have **no defaults** — a file without them fails the build
on purpose. A new pricing file that silently defaulted to the permissive setting is
exactly the accident worth preventing.

### The opening answer

One chunk is marked with `opening_section:` in its file's frontmatter — currently
`What EatLabs is` in `00-identity-and-contact.md`. It is what the agent falls back to
when someone types "hi", "what are you" or "tell me about eatlabs".

These questions have nothing to search for. Before the fallback existed, "hi" was
answered with the list of booking channels and "could tell me about eatlabs?" with the
identity-verification procedure, because those chunks happened to share a rare word.
If you want a different section to be the opening answer, move the key — do not add a
second one, because the build refuses two.

### `> Spoken:`

The short, voice-safe version of the section. **This is what gets read aloud.** The full
section text (tables and all) is what the text agent uses.

Rules for a `Spoken:` line:

- **Numbers as digits** — `₹35,000`, `7:30 pm`, `90 days`. Do *not* spell them out.
  `services/tts/spoken.py` converts digits to words at speech time, in English, Hindi and
  Kannada, and it is tested. Writing "thirty-five thousand" bypasses it and breaks Hindi
  and Kannada, which cannot normalise an English number word.
  *(30 existing lines still spell numbers out. `audit_kb.py` lists them under
  "spoken spells a number out". They are being fixed; do not add more.)*
- No tables, no URLs, no bullets, no markdown.
- Two sentences at most. On a phone call, a long answer is a bad answer.
- Every section that a visitor might hear needs one. `build_kb.py` warns if one is missing.

---

## What the answer gates will refuse to say

Worth knowing, so a blocked answer in the console doesn't look like a bug. Each of these
falls back to "I do not want to guess at that — message us on WhatsApp…":

| Refused | Why |
|---|---|
| A ₹ figure not in a retrieved passage | Invented pricing |
| A percentage not in a retrieved passage | Invented performance or uptime claims |
| Anything matching `[LIKE THIS]` | The live legal pages have unfilled template blanks (`[GRIEVANCE OFFICER NAME]`, `[REGISTERED OFFICE ADDRESS]`). Never read one out. |
| An empty reply | — |

So if you add a correct new price and the agent still refuses it, the usual cause is that
the chunk holding it was not retrieved. Check the "passages retrieved" panel in the
console before suspecting the gate.

---

## If you add or change chunks and dense retrieval is on

`kb.vectors.jsonl` is a cache of this folder's text. Rebuild it in the same breath as
`kb.jsonl`, or a chunk will keep answering as the paragraph it used to be:

```bash
python tools/build_kb.py ./knowledge-base ./kb.jsonl
EMBED_BASE_URL=http://127.0.0.1:8001/v1 node tools/embed_kb.ts
```

If there is no embedding endpoint, skip it — search stays lexical and everything works.

## When the website changes

`tools/watch_site.py` re-scrapes the live site, diffs it, and flags what to re-read.

```bash
python tools/watch_site.py              # what changed since last run
python tools/watch_site.py --update     # also refresh source-raw/ and the manifest
```

Exit codes: `0` nothing changed · `10` a person should look · `20` site unreachable.

It **deliberately does not edit this folder.** It updates the raw scrape and opens an
issue listing the chunks most likely affected, ranked by vocabulary shared with the lines
that actually changed. A human then edits the curated file. The reason: a pricing page
rendering wrong for ten minutes mid-deploy would otherwise teach the agent a wrong price,
and the agent would say it with complete confidence on a sales call.

`.github-workflow-kb-refresh.yml` runs this hourly. It is **not** installed under
`.github/workflows/` yet — move it there when you want the schedule live.

---

## Known gaps

Open issues in the content itself, not the code:

1. **No published Credit allowance per plan.** The pricing page implies a flat ₹35,000;
   the Terms describe a metered Credits model. Nowhere states how many Credits a plan
   includes. The agent is instructed to say it depends on volume and offer a callback.
2. **No liability chunk.** The site publishes two caps — ₹10,000 or the amount paid for a
   booking, whichever is higher, for diners (Guest Terms §12); fees paid in the last 12
   months for restaurants (Terms §20). Neither is in this folder yet.
3. **No uptime figure exists.** EatLabs does not publish one; it goes in an order form.
   Do not add one.
4. **Unfilled placeholders are live** on the published legal pages. See `99-guardrails`.
5. ~~**Mixed domains:**~~ resolved on 2026-11-02 — the site now uses `eatlabs.io`
   throughout, for the app, the API and every email address.
6. **A question that shares one word with the KB but is about something else** can
   still retrieve a chunk — "how do I change a tyre" matches `change`. It scores about
   3.4 against roughly 4.4 for the weakest genuine question, and that gap is too narrow
   to cut off without eventually silencing a real one. Questions sharing no word at all
   already retrieve nothing and hand over.

---

## Checklist before you commit

- [ ] `python tools/build_kb.py ./knowledge-base ./kb.jsonl` — exits 0
- [ ] `python tools/audit_kb.py` — exits 0, no `UNGROUNDED`
- [ ] `node tests/retrieval_tests.ts` — all pass
- [ ] New sections have a `> Spoken:` line, with digits not words
- [ ] `kb.jsonl` is committed alongside the markdown (it is what runs)
- [ ] Asked it the question in the console and read the answer out loud
