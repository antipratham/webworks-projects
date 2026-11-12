# EatLabs Voice + Text Agent — Knowledge Base

Knowledge base and test console for one general assistant that answers questions about
EatLabs over voice or text. The site content was **scraped from the live site**
(eatlabs.io) on **2026-10-27**; anything the site does not publish is kept verbatim in
`source-provided/` with a note of who supplied it. No local project folders were used as
a source.

**Editing the knowledge base: see [`knowledge-base/README.md`](knowledge-base/README.md).**
That is the guide for whoever maintains the content — format, the rebuild loop, the
checks, and what the answer gates refuse to say.

## What's here

```
AGENT-INSTRUCTIONS.md   The system prompt + rationale. REVIEW THIS FIRST.
package.json            node >=22.18, zero runtime deps (matches menu-ai/)
serve.ts                Test console: node serve.ts -> http://127.0.0.1:3100
src/
  triage.ts             Abuse, gibberish and empty input. Answered before search runs.
  conversation.ts       Who asked what, so "is that with GST?" knows what "that" is
  retrieve.ts           BM25 + synonyms, fused with dense vectors when they exist
  embed.ts              Embedding client (any OpenAI-compatible /v1/embeddings)
  prompt.ts             The system prompt as code. Mirrors AGENT-INSTRUCTIONS.md §2.
  llm.ts                vLLM client (same Qwen3-30B-A3B as the voice agent) + no-model fallback
  answer.ts             The output gates: invented price/percent/placeholder -> handover
web/index.html          The UI: ask, read, hear it spoken, inspect the passages
tests/retrieval_tests.ts  156 tests, no model needed: node tests/retrieval_tests.ts
tools/
  watch_site.py         The autoscraper. Change detection + chunk-level review targeting.
  crawl_eatlabs.py      Scrapy crawl of every page. Finds sections nobody listed.
  audit_kb.py           Every figure in the KB must exist in a source. Exits 1 if not.
  embed_kb.ts           Build kb.vectors.jsonl for dense retrieval (needs an endpoint)
  eval_questions.ts     Score retrieval over eval/questions.jsonl. --hybrid, --write
eval/
  questions.jsonl       113 questions a visitor asks, and the chunk that should answer
  ANSWERS.md            GENERATED. What the agent replies to each one, today
services/embed/
  server.py             CPU /v1/embeddings for local testing. No GPU needed
.github-workflow-kb-refresh.yml   Hourly watch -> commit scrape -> open a review issue

knowledge-base/      Curated, answer-shaped docs — the thing you actually retrieve from
  README.md                         HOW TO EDIT THIS. Start here for content changes.
  00-identity-and-contact.md        Company, contact, hours, scale claims
  01-product-overview.md            The core idea, module map, languages
  02-ai-calls-and-voice-host.md     AI phone host, recording, what it may/may not do
  03-reservations-floor-waitlist.md Availability engine, floor plan, deposits
  04-whatsapp-crm-loyalty-...md     WhatsApp bot, CRM, loyalty, campaigns, consent
  05-menu-reviews-events-...md      QR menu, reviews, events, aggregators, API
  06-pricing-and-billing.md         Plans, Credits, invoicing, termination
  07-security-privacy-compliance.md Residency, sub-processors, retention, SLA
  08-guest-rights-and-deletion.md   DPDP rights, deletion flow, opt-out
  09-who-its-for-and-objections.md  Segments, integrations, objection handling
  10-webworksco.md                  WebWorks Co. — supplied, not scraped
  99-guardrails-and-known-gaps.md   AGENT-ONLY. Pin this into the system prompt.

source-raw/          Verbatim scrape of all 11 pages + _scraped.json (provenance)
source-provided/     Copy the site does not publish, verbatim, with who supplied it
tools/
  scrape_eatlabs.py  Re-scrape the site (stdlib only)
  build_kb.py        Rebuild kb.jsonl from the curated markdown
kb.jsonl             104 retrieval chunks, ~118 tokens average
```

## Regenerating

```bash
python tools/scrape_eatlabs.py ./source-raw                 # re-scrape the site
python tools/build_kb.py ./knowledge-base ./kb.jsonl        # rebuild the index
python tools/audit_kb.py                                    # check every figure
node tests/retrieval_tests.ts                               # check nothing broke
```

`build_kb.py` refuses to build a file missing `visibility:` or `sensitivity:` — both
decide behaviour, so neither gets a default. It also warns about chunks over 400 tokens
and chunks missing a `Spoken:` line. Both warnings are currently zero — keep them there.

`audit_kb.py` is the one that matters: **every figure in the knowledge base must appear in
`source-raw/` or `source-provided/`**, and it exits 1 if one does not. All 68 currently
ground. A price the agent quotes confidently and cannot source is the worst failure this
project has, and no amount of prompt or retrieval work catches it.

## The chunk format

Every `##` section in a curated file becomes one chunk. The convention that matters:

```markdown
## How to request deletion

> Spoken: There's no form to hunt for. Email privacy at eatlabs dot in,
> or WhatsApp +91 80 4000 1200.

| Channel | Where |
|---|---|
| Email | privacy@eatlabs.in |
...
```

- `spoken` — a short, voice-safe rendering. **Numbers as digits**, no tables, no URLs.
  **The voice agent reads this.** 94 of 104 chunks have one, and every guest-facing chunk
  does — the ones without are agent-only guardrails that must never be spoken.
  (`services/tts/spoken.py` turns digits
  into words at speech time, in all three languages. 30 lines still spell them out —
  `tools/audit_kb.py` lists them.)
- `text` — the full version, with tables. The text/chat agent uses this.
- `sensitivity: high` on pricing, security and guest-rights chunks — gate these behind
  a stricter answer policy (quote exactly, never paraphrase a number).
- `visibility: agent-only` on the guardrails doc — never retrievable as a passage. There
  is no other audience distinction: one assistant serves everyone who opens the site.
- `provenance: provided` where the claim came from supplied copy rather than a page.

## Recommended architecture: RAG **and** an LLM, not a choice between them

These aren't alternatives. RAG is how the agent gets the facts; the LLM is how it
understands a question and forms a sentence. The real decision is **how much the LLM is
allowed to do**, and here the answer is: retrieve strictly, generate narrowly.

| Layer | Choice | Why |
|---|---|---|
| Retrieval | BM25 + a hand-written synonym table, fused with dense vectors when an embedding endpoint exists | Vector search misses exact strings people say — "Petpooja", "₹35,000", "DPDP". And `menu-ai/` ships zero runtime deps, so there is no embedding library to reach for. The synonym table closes the one real gap (*"cost"* never appears in a pricing section that says *"price"*). Add embeddings later as a second scorer if an embedding endpoint ever runs beside vLLM. |
| Generation | LLM, constrained to retrieved chunks | 104 chunks won't cover every phrasing; you need real language understanding, in 3 languages, over a phone line with ASR errors |
| Guardrails | `99-guardrails` pinned in the system prompt | Never retrieved — always present |
| Escalation | Tool call to capture a lead / book a demo | The agent's only write action |

**Why not fine-tuning:** the content changes (prices, the 120+ figure, the sub-processor
list). A fine-tune bakes today's prices into weights you can't cheaply correct. Re-scraping
and re-indexing is a two-minute job; retraining is not.

**Why not a plain LLM with the whole KB in the prompt:** it's tempting — the whole KB is
only ~12k tokens and would fit. For the **text** agent that's actually defensible, and with
prompt caching it's cheap. For **voice** it isn't: latency is the product, and a smaller
retrieved context is a faster first token. Retrieval also gives you citations, which is what
lets you prove where a pricing answer came from.

**Why not retrieval alone (no LLM):** an FAQ matcher would fail the moment someone asks
"so if I'm on Zomato already, is this worth it?" — a question whose answer is assembled from
three chunks and isn't phrased like any of them.

### Edge cases, before retrieval runs

`src/triage.ts` answers three kinds of input without touching the index, because BM25
will always rank *something* and all three used to get a passage:

| Input | Reply |
|---|---|
| Abuse | "I would rather keep this useful. Ask me anything about EatLabs, or message us on WhatsApp…" |
| Gibberish — `asdkjhasd`, `qwertyuiop`, a pocket dial | "I did not catch that. Could you say it again?" |
| Misheard — see below | "I did not catch that. Could you say it again, a little closer to the microphone?" |
| Empty | "Ask me anything about EatLabs." |

**Misheard** is its own kind because it is the failure that will *not* survive the move
to a self-hosted recogniser. Gemini, asked to transcribe silence, returns the sentinel it
was told to and [stt.ts](src/stt.ts) maps that to nothing. Whisper does not. It is trained
largely on subtitle tracks, so when the audio carries no speech it reaches for the
furniture of that training data and says it fluently:

```
Thank you for watching!              Subtitles by the Amara.org community
Please subscribe to my channel.      [Music]        (inaudible)
the the the the the the              cost cost cost cost what cost cost
```

Those are real words in a real sentence, so every other check here waves them through.
They are caught in code, on `source: 'voice'` only — typed, the same words are a person
saying an odd thing and get an ordinary answer. The looping check needs six words before
it means anything, so *"is it per outlet or per outlet group"* is still a question.

Two distinctions it is built around. **A complaint is not abuse** — "your product is
rubbish, how do I cancel?" is answered from the knowledge base, because someone annoyed
is still asking something. And **Hindi and Kannada are never gibberish**: the
vowel-and-consonant test only applies to Latin script, so a Devanagari or Kannada
question always passes.

The abuse list is short, whole-word, and meant to be extended. It will never be
complete, and does not need to be — everything it misses falls through to the ordinary
path, which answers or hands over. It is deliberately resistant to the obvious evasions
(`sh1t`, `f u c k`, `fuuuuck`) and deliberately safe on `assessment`, `bookkeeping`,
`address` and `Scunthorpe`.

### Making sure the deployed model behaves like the testing one

The question this has to answer is "will Qwen handle the edge cases the way Gemini does?"
That is not one question, it is two, and they have different answers.

**The half that is not the model's.** Which route an input takes, and every fixed reply,
are decided by [triage.ts](src/triage.ts) and `plan()` in [answer.ts](src/answer.ts). No
model is involved in either, so swapping the endpoint cannot change them. Abuse,
gibberish, a misheard line, a greeting, the lexical veto, both output gates — identical
on any model, by construction rather than by hope.

**The half that is.** What the model then writes is its own. That cannot be asserted, so
it is measured:

```bash
node --env-file=.env tools/eval_edges.ts --save eval/edges-gemini.json   # baseline, now
LLM_BASE_URL=http://gpu:8000/v1 node tools/eval_edges.ts --delay 0     --compare eval/edges-gemini.json                                     # launch day
```

43 cases — greetings in three scripts, abuse, keyboard mash, recogniser artefacts,
transcripts with a stutter in them, off-topic questions, prompt injection, and the five
things the agent must refuse even though it knows them. The first column is asserted and
the run fails if it moves. The second prints both models' replies side by side, and the
number to watch is **how often the gate fires**: that is the model failing to keep to the
rules and being stopped, which is safe but unhelpful.

Baseline on 2026-10-29, `gemini-3.5-flash-lite`:

```
decided in code, so identical on every model: 43/43
open route      15/15 answered, 0 gate fired
grounded route  17/17 answered, 0 gate fired
mean latency    1024 ms
```

`--delay` exists because the Gemini free tier allows only a few requests a minute and a
burst of forty exhausts it half way through. A local vLLM needs none of it. A run with
any unreachable call in it fails rather than being reported as a result — the first
version of this tool counted a 429 as the gate firing, which made a broken run look like
a strict one.

**What it cannot test.** A transcript misheard into other real words — "Growth" into
"gross", "outlet" into "outlook". No filter can catch that, on any model, because there
is nothing wrong with the sentence. The mitigations are that the console shows the
transcript before asking, and that both prompts now carry one rule: if you cannot tell
what they meant, say so and ask them to put it another way, rather than answering the
question you think they probably meant.

### Dense retrieval: reading the question, not its keywords

BM25 cannot match *"is this worth it if I'm already on Zomato?"* to a section on
aggregator commissions — they share no vocabulary. The synonym table only ever closes a
gap someone has already tripped over. Embeddings close the ones nobody has hit yet.

```bash
EMBED_BASE_URL=http://127.0.0.1:8001/v1 node tools/embed_kb.ts   # writes kb.vectors.jsonl
EMBED_BASE_URL=http://127.0.0.1:8001/v1 node serve.ts            # hybrid search
```

Defaults to `BAAI/bge-m3`, chosen because it is multilingual and this agent answers in
three languages. Any OpenAI-compatible `/v1/embeddings` endpoint works — vLLM and TEI
both serve one.

**The two are fused by rank, not score.** BM25 is unbounded and query-dependent; cosine
is bounded. Putting them on one scale needs a normalisation constant that is itself a
guess, so reciprocal rank fusion is used instead: a chunk both methods like rises, and a
chunk only one likes still gets a hearing. Dense hits are floored at cosine `0.42`,
without which cosine ranks all 104 chunks for any input and the agent is back to always
having an answer.

**It is off until both halves exist**, and off is not a degraded mode — lexical search is
what has been answering all along. A missing endpoint, a missing `kb.vectors.jsonl`, or
an endpoint that fails mid-request all fall back to BM25, and there is a test for each.
`kb.vectors.jsonl` is generated and gitignored: rebuild it whenever `kb.jsonl` changes,
or chunks answer as the paragraphs they used to be.

### Measuring retrieval, instead of arguing about it

```bash
node tools/eval_questions.ts                       # lexical
EMBED_BASE_URL=http://127.0.0.1:8001/v1   node tools/eval_questions.ts --hybrid --write    # + dense, and regenerate ANSWERS.md
```

113 hand-written questions, each tagged with the chunk that ought to answer it. The
questions are phrased the way a visitor types them, not the way the headings read. The
**answers are not written by hand** — `eval/ANSWERS.md` is generated from `kb.jsonl`, so
it cannot drift from what the agent actually says.

| | rank 1 | top 3 | top 5 | not found |
|---|---|---|---|---|
| Lexical only | 72.6% | 89.4% | 92.9% | 8 |
| **+ dense (e5-small, CPU)** | **79.6%** | **94.7%** | **96.5%** | **4** |

Measured with a 118M model on a laptop CPU — the smallest multilingual option there is.
It also reports how many real questions `triage` wrongly held back, which must stay at 0.

### Testing the whole thing on a laptop, with no GPU

Dense retrieval does not need the GPU box. The knowledge base is 104 chunks and a
question is one sentence:

```bash
python -m pip install transformers torch
python services/embed/server.py                               # port 8001, downloads ~470 MB
EMBED_BASE_URL=http://127.0.0.1:8001/v1 node tools/embed_kb.ts
EMBED_BASE_URL=http://127.0.0.1:8001/v1 node serve.ts         # retrieval: hybrid
```

The language model is a different matter — Qwen3-30B-A3B needs ~31 GB of GPU memory and
cannot run on a laptop. Retrieval, which is where the faults have been, can.

### Why dense retrieval cannot overrule lexical

The obvious design is a cosine floor: below it, no answer. Measured over this knowledge
base with multilingual-e5-small, that does not work.

```
real questions    best cosine 0.813 – 0.944
off-topic         best cosine 0.739 – 0.833     ← overlapping
"best biryani recipe" scores 0.819, above the weakest real question at 0.813
```

An embedding always has a nearest neighbour, and here an unrelated question's nearest
neighbour sits inside the range real questions occupy. **No threshold separates them.**

So the rule is not a threshold. Dense retrieval may **reorder** what BM25 found; it may
not **introduce** an answer where BM25 found none. A question about tyres or biryani
shares no vocabulary with any chunk, BM25 returns nothing, and the agent hands over —
which keeps the right to say "I don't know" that the rest of this design is built on.

**The one exception is a script BM25 cannot read.** `tokenize` keeps only `[a-z0-9]`, so
a Hindi or Kannada question produces no terms, lands in the opening fallback, and before
this was fixed *every* Indic-script question was answered with "what EatLabs is",
whatever it asked. There, lexical silence is not weak evidence — it is no evidence — so
the dense ranking stands alone. Seven of seven Hindi and Kannada test questions now
retrieve the right chunk.

This is the case dense retrieval earns its place on: **two of the three languages this
agent supports have no lexical retrieval at all.**

### Greetings

"hi", "hello", "thanks", **नमस्ते**, **नमस्कार**, **ನಮಸ್ಕಾರ**, "namaste" and the rest are
greeted back, in the language they were typed in.

This needs its own script-aware check rather than the filler list, because `tokenize`
keeps only `[a-z0-9]`. A Devanagari or Kannada greeting produces no tokens at all, so it
reached neither the filler test nor the opening fallback, went to the dense ranking, and
got whatever sat nearest: **नमस्ते** was answered with the sub-processor list and **ನಮಸ್ಕಾರ**
with the data-deletion policy.

A greeting attached to a question is a question: *"hi, how much does it cost?"* retrieves
the pricing chunk.

### Answering when the knowledge base has nothing

Retrieval returning nothing used to produce one sentence, every time: *"I do not want to
guess at that. Message us on WhatsApp."* Right for *"what is your uptime SLA"*. Absurd for
*"hi"*, *"thanks"*, *"are you a robot"*, *"what is the capital of France"*.

So `plan()` in `answer.ts` picks one of two routes, and the route decides both the prompt
and the gate — they are chosen together so neither can be used with the wrong one.

| | Grounded | Open |
|---|---|---|
| Reached when | retrieval returned ≥ 1 passage | a greeting, or retrieval returned nothing |
| Prompt | `src/prompt.ts` — answer from these passages | `src/open.ts` — you were given none, deliberately |
| Gate | every ₹ and % must appear in a passage | **no figure at all**, bar the WhatsApp number |
| Fails to | the handover sentence | the handover sentence |

```
Q  what is the capital of France?
   [open]  The capital of France is Paris. Let me know if you need any help with EatLabs.

Q  how much does the Growth plan cost?
   [grounded]  The Growth plan costs 35,000 rupees per month per venue, and GST is extra.

Q  नमस्ते
   [open]  नमस्ते! मैं EatLabs का असिस्टेंट हूँ, बताइए मैं आपकी क्या सहायता कर सकता हूँ?
```

**Why the open gate is a blanket ban on digits.** It would be nicer to reject only claims
about EatLabs, but code cannot tell a claim from a remark. What it can use is that every
fact about this product that would hurt to get wrong is a *number* — a price, a share, a
notice period, a retention window, an uptime figure, an outlet count. A reply with no
digits in it cannot carry one, whatever the model believed it knew. The prompt asks for
small numbers as words so the model is not fighting the rule.

The cost, stated rather than hidden: *"how many continents are there"* hands over. That is
the price of a rule with no judgement in it, and it is cheap.

The open route is only reached when retrieval found **nothing**, and because of the
lexical veto above, nothing is a strong signal rather than a weak one: the question shares
no vocabulary with anything EatLabs publishes. A product question worded oddly still
retrieves something and still goes down the grounded route. Abuse, gibberish and an empty
box never reach either route — triage answers those first.

With no model installed there is nothing to be open with, so the stub client hands over,
which is the honest answer.

### Asking by voice

`src/stt.ts`, two clients behind one interface, and the interface is the deployment's:

| | |
|---|---|
| **Whisper** | `POST /v1/audio/transcriptions`, multipart — the OpenAI shape that faster-whisper, whisper.cpp and vLLM all serve. Set `STT_BASE_URL` and nothing else changes. |
| **Gemini free tier** | For testing before the GPU box exists. Gemini's OpenAI layer has no transcriptions endpoint, so this one posts the audio inline to the native API. A stand-in, written to be deleted. |

With no `STT_BASE_URL`, a Gemini key already set for the language model is reused for
transcription too. `STT_PROVIDER=off` hides the microphone.

The browser records **16 kHz mono WAV** rather than handing the job to `MediaRecorder`,
which would be less code. Two reasons, both about the far end: `MediaRecorder` gives
whatever container the browser prefers — WebM/Opus in Chrome, MP4/AAC in Safari — and no
two transcription endpoints accept the same list. WAV is accepted by all of them. And
16 kHz mono is Whisper's native input, so anything else just gets resampled server-side
for a larger upload. The cost is about 32 KB a second, uncompressed.

Two requests, not one: the audio is transcribed and shown, *then* asked. ASR is wrong
often enough that silently answering a misheard question is the worse failure. The
transcript then goes in at the front of the ordinary pipeline — triage, retrieval, gate —
exactly as if it had been typed. **A microphone is an input device, not a second way in.**

The known limit of the Gemini stand-in: a chat model asked for a transcript sometimes
tidies grammar, and occasionally answers the question instead of transcribing it. The
instruction says verbatim three ways and the temperature is zero, which held in testing,
but it is not an ASR — Whisper will be better, and noticeably so in Hindi and Kannada.

The microphone needs `https` or `localhost`. Over a plain `http://` LAN address the
browser blocks `getUserMedia` and the console says so rather than failing silently; the
cloudflared tunnel is https, so a remote tester is fine.

### Testing against Gemini before the GPU exists

The client speaks plain OpenAI protocol, so any OpenAI-compatible endpoint works —
including Gemini's, which means the LLM layer can be exercised before a GPU is rented:

Put the key in `.env` — which is gitignored, so it cannot be committed — and start with
`--env-file`. `.env.example` lists every variable with no values in it.

```bash
cp .env.example .env     # then paste the key after LLM_API_KEY=
node --env-file=.env serve.ts
```

A key committed to git is leaked even after it is deleted, because the history keeps it.
Never put one in a tracked file, and rotate it if it ever lands in a commit.

`chat_template_kwargs` is vLLM's own field and is **omitted for a non-local address**, since
a hosted endpoint rejects the whole request over an unknown field. Override the guess with
`LLM_VLLM_EXTRAS=1` or `0`.

**What this does and does not prove.** It exercises the prompt, the output gates, SSE
streaming and the sentence-release path end to end — the plumbing. It does **not** predict
how Qwen3-30B-A3B will behave: instruction-following, sentence length, and when a model
chooses to say "I don't know" all differ, and Gemini is the more obedient of the two. Treat
a green run as "the wiring works", not "the agent is good".

**And it leaves the self-hosted path.** The knowledge base is scraped public marketing
copy, so no guest data is involved — but the system prompt also carries
`99-guardrails-and-known-gaps`, which is an internal assessment of the live site's faults.
That goes to Google with every request. Fine for a test account against public content;
not something to leave switched on.

### Voice-specific notes

- Read the `spoken` field, not `text`. The difference between "₹35,000/mo" and
  "thirty-five thousand rupees a month" is the difference between a demo and a hang-up.
- Keep retrieval to top-3. On a call, a long answer is a bad answer.
- Barge-in matters more than completeness. Answer in two sentences, then offer more.
- Mirror EatLabs' own design decision: the AI phone host **cannot reach destructive
  functions at all** — they aren't exposed to it. Build the same way. If your agent has
  no refund tool, no caller can talk it into a refund.

## Remembering the question before this one

Every question used to be the first one. "What does Growth cost?" answered fine and
"is that with GST?" retrieved nothing, because BM25 has no idea what `that` refers to.
A visitor could not ask a second question about the same thing, which is most of how
people talk and all of how they talk out loud.

`src/conversation.ts` keeps the turns, **on the server**, keyed by an opaque id. The
page is issued the id and echoes it back; it never posts a transcript. That split is
not tidiness, it is the whole security of the thing. `answer.ts` lets a figure out only
if it appears in the context the model was given, and a follow-up's context includes
the earlier turns — so a page that could invent a prior turn saying "Growth is ₹9,000 a
month" could then ask "what was that price again?" and the gate would pass it, because
the figure really would be in the context. Everything the gate trusts was put there by
this server, after passing the gate itself.

### What gets carried, and what does not

A follow-up's **retrieval query** is widened with the content words of the last question
that named a subject. Not the answer, not the headings of the passages that answered it.

That restraint was learned the hard way. The first version carried passage headings too
— they look like free topic vocabulary. They are not free: headings are the *output* of
a search that may itself have been widened, so each turn's result fed the next turn's
query. Five questions into a thread about pricing, every query had collected enough of
the plans table that "what documents will I need?" returned the plans table. Questions
are written by the visitor and cannot loop; search results can.

Widening also only happens when the question cannot stand on its own — fewer than two
content words once filler and pronouns are stripped. "Is that with GST?" has one (`gst`)
and needs help. "What documents will I need?" has two and is buried by help.

### What it costs

The gate is now closed over the **conversation** rather than the single turn: a figure
retrieved three questions ago can still be repeated. That is a real widening and it is
deliberate — an agent that answers its own previous sentence with "I do not want to
guess at that" is broken in a way visitors notice immediately. The set of quotable
figures is still exactly what the knowledge base published, and nothing a visitor types
can add to it.

Turns are capped at 8, conversations expire after 2 hours, and the store is capped at
500 live threads. It is in memory, so it is lost on restart — correct for a console,
and the thing to keep if it ever moves behind Redis is the direction of travel: a
request carries an id, never a transcript.

## Keeping up with the website

`tools/watch_site.py` discovers every page (sitemap **and** a crawl, because a new page is
often linked before it is listed), extracts the text, and compares it with the last run.

```bash
python tools/watch_site.py              # what changed since last run
python tools/watch_site.py --update     # also rewrite source-raw/ and the manifest
```

Exit codes: `0` unchanged · `10` a person should look · `20` site unreachable.

What makes it useful rather than noisy:

- **It ranks the chunks you need to re-read.** A homepage change nominally touches 66
  chunks, because almost every curated file cites the homepage. It scores each citing
  chunk by vocabulary shared with the lines that actually changed, so a price edit
  surfaces `pricing#the-published-plans` first and eight candidates in total.
- **It separates risk from noise.** A changed line matching money, contract, or
  compliance wording is flagged HIGH RISK. A reworded testimonial is not.
- **It never writes the curated KB.** It commits the raw scrape — provenance, read by
  nothing at answer time — and opens an issue. A pricing page that renders wrong for ten
  minutes during a deploy would otherwise teach the agent a wrong price, and the agent
  would then say it on a sales call with complete confidence.

### "Real time"

There is no webhook from a static marketing site, so real time is one of two things:

1. **The hourly schedule** in `.github-workflow-kb-refresh.yml` — the honest default.
2. **A `repository_dispatch` from the website's own deploy** — genuinely real time. If the
   site deploys from CI, add one step there:
   `gh api repos/vinodwebworksco/eatlabs-llm-voice/dispatches -f event_type=site-deployed`

## The test console

```bash
node serve.ts                                        # works with nothing installed
LLM_BASE_URL=http://127.0.0.1:8000/v1 node serve.ts  # with the real model
TTS_BASE_URL=http://127.0.0.1:8020  node serve.ts    # speech out: Indic Parler-TTS
STT_BASE_URL=http://127.0.0.1:8010/v1 node serve.ts  # speech in: Whisper
node --env-file=.env serve.ts                        # everything, from .env
```

With neither service up it still runs: the answer is the best-matching passage read back,
and speech is the browser's own voice. You can test retrieval before any GPU exists.

Speech prefers the server's Indic Parler-TTS over the browser, because that service runs
`services/tts/spoken.py` — the tested normaliser that turns `35,000` into words correctly
in English, Hindi and Kannada. A browser voice cannot do that for Hindi or Kannada.

The page also shows, for every answer: which passages were retrieved, their scores,
whether a passage was scraped or supplied, which of the two routes answered, and — if an
output gate fired — what the model *wanted* to say and why it was blocked.

### The microphone

Press it, speak, press it again. It shows the seconds elapsed and a ring that grows with
the sound, so a dead microphone is obvious before a whole question has been spoken into
it; it stops itself at 60 seconds; and it releases the device on every exit, including an
error and a page unload. What was heard is shown under the box before it is asked, so a
misheard question can be retyped rather than answered.

Arm the speaker first and it is a full loop: speak the question, hear the answer sentence
by sentence as it clears the gate. The button is hidden entirely when the server has no
transcription configured.

### The speaker control

One icon, two jobs. Text is always written either way.

| | |
|---|---|
| **Armed before asking** | Audio follows the text as it is written. Each sentence is spoken as it lands. |
| **Pressed on a finished answer** | That answer is read back. Press again to stop. |

Armed mode uses `/api/ask/stream`, and the thing worth understanding about it is where the
gate sits. A sentence is held until it is **complete**, then checked, and only then
released to be displayed and spoken. Tokens are never spoken as they arrive: `₹25` and
`,000` reach the server as separate tokens, and a gate running per token would either
block a correct price or wave a wrong one through. Buffering to a sentence boundary means
every figure is weighed whole, at a cost of one sentence of latency instead of the whole
reply.

The honest trade: a released sentence cannot be recalled. If the fourth sentence invents a
price, the first three have already been spoken — each one checked and clean — and the
answer then stops and hands over mid-flow. That is more abrupt than a reply checked whole,
which is why the unarmed path remains the default.

## Known problems found while scraping

Four things on the live site need fixing — detail in `99-guardrails-and-known-gaps.md`:

1. **Unfilled placeholders** are published in the legal pages: `[SUPPORT HOURS]`,
   `[REGISTERED OFFICE ADDRESS]`, `[GRIEVANCE OFFICER NAME]`, `[EMAIL PROVIDER]`.
2. **Pricing contradicts the Terms.** The page says "no contract"; Terms §18.1 require
   30 days' notice before auto-renewal. The page implies a flat ₹35,000; Terms §4 describe
   a metered Credits model. **The Credit allowance per plan is published nowhere** — the
   biggest gap for a sales-facing agent.
3. **Domains are mixed:** `eatlabs.io` for the site and sign-in, `eatlabs.in` for email,
   API and in-product screenshots.
4. **robots.txt** declares the sitemap as `https://www.restro.app/sitemap-index.xml` —
   a different domain — and disallows `/legal/`.
