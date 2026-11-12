# WebWorks Projects

Six AI/ML builds, one per folder. Each folder has its own README with setup and detail.

## Projects

- **[Proposal Generator Agent](AGENTIC%20AI%20APPLICATION/)** — Researches a prospect company, derives grounded strengths, gaps and recommended services, and renders the result into the WebWorks sales proposal PDF template. Python + Node (`pdf-lib`).
- **[Book Search Typeahead](AUTOCOMPLETE%20FEATURE/)** — Search-engine-style suggestion box over a book catalog; matches update on every keystroke via prefix and keyword indexing, with an optional semantic embedding layer. FastAPI + plain HTML.
- **[WhatsApp Notification Service](WHATSAPP%20BOT/)** — Event-driven outbound WhatsApp on the Meta Cloud API: approved template and language per backend event, consent gate, delivery state machine, full audit trail, plus the feedback survey conversation. TypeScript + Postgres.
- **[EatLabs Website Voice + Text Agent](EATLABS/Eatlabs%20Website%20Voice%20Agent/)** — One assistant answering questions about EatLabs over voice or text, grounded in a knowledge base built from published site content, with gates on what it may not say. TypeScript.
- **[AI Menu Concierge](EATLABS/MENU%20AI/)** — Guest describes what they want in plain language and gets real dishes from that outlet's menu, grouped by menu section, with no taste, dietary or allergen claim the dish's own data does not carry. TypeScript + self-hosted Qwen3 via vLLM.
- **[Live Call Monitor](EATLABS/live-monitor/)** — Development view of a phone call as it happens: the dialogue, the knowledge base of the restaurant dialled, and the dead air before each reply. Python stdlib only.

## Notes

- Every project reads its config from `.env`. Copy the folder's `.env.example` where one exists; no real `.env` is committed.
- Generated output is not committed: research reports, generated proposals, sample PDFs, vector indexes, build output, logs.
- Four related projects live in their own repositories: Restaurant Voice Agent, AI Reviews & Feedback, Clinical SOAP Report Agent, SumeruBot.
