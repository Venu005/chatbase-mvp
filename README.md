# Chatbase India (MVP)

Train an AI support agent on a business's website, PDFs and FAQs, then add it to any website with one `<script>` tag or
connect it to WhatsApp. A working first version of a Chatbase-style product for Indian small businesses: Hindi, Hinglish
and regional-language questions, WhatsApp, INR subscriptions, and a human-handoff inbox.

## What works today

- Sign up / log in (e-mail + password), password reset by e-mail (signs out other sessions), per-account data isolation
- Agents with custom instructions, welcome message and brand colour
- Knowledge sources: website URL (optionally crawl up to 20 same-site pages), PDF / TXT / MD / CSV upload, pasted text
- Retrieval-augmented answers with citations, streamed token by token, in the visitor's language
- Dashboard: sources, playground, settings, embed snippet, conversation inbox
- Embeddable chat bubble (`/widget.js`) and a full-page chat link (`/embed/<agent id>`); optionally limited to the owner's
  own websites, so nobody else can embed the agent and spend its message credits
- **Pluggable models**: OpenAI or any OpenAI-compatible API, Anthropic, **Sarvam** (Indian languages), or an offline mock
- **WhatsApp channel**: connect a WhatsApp Business (Cloud API) number by pasting credentials, or with the
  **Connect with Facebook** button (Embedded Signup)
- **Human handoff**: customers can ask for a person (button in the widget, or by typing it, also in Hindi/Hinglish); the bot
  goes quiet, the owner is e-mailed and replies from the dashboard inbox (also to WhatsApp customers), then hands back
- **Razorpay billing**: Starter / Growth / Pro monthly INR subscriptions; the plan changes only on Razorpay's signed webhook
- Monthly message-credit limits per plan (placeholder prices in `src/lib/plans.ts`), per-IP rate limiting

## Quick start

Needs Node 22.9+, [pnpm](https://pnpm.io) 10+ (`corepack enable`) and Postgres 15+ with pgvector (the compose file provides
one).

```bash
docker compose up -d           # Postgres + pgvector
pnpm install
cp .env.example .env           # then put a real AUTH_SECRET in it:  openssl rand -base64 48
pnpm migrate
pnpm preflight                   # checks .env and the database
pnpm dev                       # http://localhost:3000
```

With the default `.env` the app uses **mock** models, so you can click through everything without any API key. To get real
answers set the AI provider values in `.env` (recipes in [docs/providers.md](docs/providers.md)), then run
`pnpm preflight --live`, which makes real test calls and tells you what to fix.

## Configuration: copy, fill in, done

| File | Use it for |
| --- | --- |
| [`.env.example`](.env.example) | Local development. Every variable, in sections, with a comment saying where to get the value. Copy to `.env`. |
| [`.env.production.example`](.env.production.example) | A real server: https, real embeddings, safe defaults. Copy to `.env`. |

Leave a value **empty** to switch a feature off (`KEY=` is the same as not set). `pnpm preflight` validates the result.
The full variable reference is in [docs/setup.md](docs/setup.md#4-configuration-reference).

## Documentation

| Guide | Read it when you want to |
| --- | --- |
| [docs/setup.md](docs/setup.md) | install, fill in `.env`, look up any variable or command |
| [docs/providers.md](docs/providers.md) | pick models: OpenAI, Claude, Sarvam, self-hosted; embeddings; Indian-language tips |
| [docs/whatsapp.md](docs/whatsapp.md) | connect a number manually (paste Phone number ID, token, app secret) |
| [docs/embedded-signup.md](docs/embedded-signup.md) | offer the "Connect with Facebook" button to your customers |
| [docs/handoff.md](docs/handoff.md) | human takeover, the inbox, e-mail alerts |
| [docs/billing-razorpay.md](docs/billing-razorpay.md) | take INR subscriptions |
| [docs/deployment.md](docs/deployment.md) | run on a server: systemd, Caddy/https, backups, security checklist |
| [docs/testing.md](docs/testing.md) | run the unit and end-to-end tests |
| [docs/troubleshooting.md](docs/troubleshooting.md) | fix a specific error |

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev`, `pnpm build`, `pnpm start` | development / production build / production server |
| `pnpm migrate` | apply database migrations (safe to re-run) |
| `pnpm preflight [--live] [--email you@x.com]` | check `.env` and the database; `--live` also tests AI keys, Razorpay, Meta and SMTP |
| `pnpm razorpay:setup` | create the monthly INR plans in Razorpay and print the `RAZORPAY_PLAN_*` lines |
| `pnpm typecheck`, `pnpm test` | TypeScript check; 19 unit tests |
| `pnpm smoke`, `smoke:account`, `smoke:whatsapp`, `smoke:handoff`, `smoke:embedded`, `smoke:billing`, `smoke:sarvam` | end-to-end tests against fake external services |

## How it works

```
Source (URL / file / text)
   -> extract text (cheerio for HTML, unpdf for PDF)  -> chunk (~900 chars, sentence-aware, handles "।")
   -> embed (batched)                                 -> store in Postgres (pgvector)

Visitor message (widget / WhatsApp)
   -> rate limit -> is a person handling this conversation? if yes: save it, notify the owner, stay silent
   -> otherwise reserve 1 credit (atomic) -> embed question (+ previous question)
   -> top-k cosine search filtered by agent -> system prompt with numbered context + rules
   -> stream LLM reply as NDJSON -> save conversation + citations (refund the credit if generation fails)
```

Conversation history is always read from the database, never trusted from the browser.

## Testing, and what has not been tested

```bash
pnpm test                       # unit tests
pnpm build && pnpm start &      # then, with the server running:
pnpm smoke                      # 17 end-to-end checks (auth, ingestion, RAG, isolation, limits)
pnpm smoke:whatsapp             # 13 checks
pnpm smoke:handoff              # 19 checks
pnpm smoke:embedded             # 13 checks
pnpm smoke:billing              # 15 checks
pnpm smoke:sarvam               # 4 checks
```

The WhatsApp, billing, e-mail and Sarvam scripts start their own fake Meta / Razorpay / SMTP / Sarvam servers, and the
server needs the matching test settings; [docs/testing.md](docs/testing.md) has the exact commands. A headless browser
was also used to check the dashboard, the widget on a third-party page, the inbox, and the Embedded Signup popup flow
(with a fake Facebook SDK).

**None of it has been run against the live services.** Meta, Razorpay, OpenAI, Anthropic and Sarvam were exercised only
against fake servers written from their documentation. Before launching, do a real trial with a Meta test number,
Razorpay test keys and your real model keys, and use `pnpm preflight --live`. The open points to verify with Meta and
Razorpay are listed in [docs/embedded-signup.md](docs/embedded-signup.md) and [docs/billing-razorpay.md](docs/billing-razorpay.md).

## Roadmap for the Indian market

1. **WhatsApp**: a BSP such as Gupshup as an alternative, media and voice-note messages, template messages (needed to
   write to a customer after the 24-hour window). Check Meta's current per-message pricing before setting plan prices.
2. **Billing**: GST invoices, in-place plan changes/proration, UPI Autopay mandate messaging, usage-based top-ups.
3. **Indian-language quality**: compare multilingual embedding models on real customer questions (Sarvam covers chat only).
4. **Voice**: speech-to-text + text-to-speech around the same agent for phone/IVR use cases.
5. **Compliance and hosting**: host in an Indian region, data-processing agreement, deletion/export endpoints and breach
   procedures for the DPDP Act; consider SOC 2 / ISO 27001 for larger customers.
6. **Product depth**: lead capture, actions (order status, bookings), analytics, team seats, assigning conversations to teammates.

## Before you go to production

The full list is in [docs/deployment.md](docs/deployment.md). The important points:

- Ingestion and WhatsApp replies run in the web process after the response is sent. That is fine on a normal server; on
  serverless move them to a queue/worker (pg-boss, BullMQ, Inngest).
- Rate limiting and handoff polling counters are in memory (per process). Use Redis if you run more than one instance.
- URL fetching blocks private/loopback addresses but cannot fully stop DNS rebinding; put an egress proxy in front for
  untrusted users. Never set `ALLOW_PRIVATE_URLS=true` on a public deployment.
- Set your own `ENCRYPTION_KEY` and back it up; customers' WhatsApp tokens are encrypted with it.
- Missing on purpose in this MVP: e-mail verification, password reset, GST invoicing, per-agent domain allow-listing,
  admin tools, data retention/deletion for stored phone numbers (personal data under the DPDP Act).
- `pnpm audit` reports PostCSS advisories through Next.js 15's bundled copy. They concern processing untrusted CSS, which
  this app never does; upgrade Next when a fixed release you have tested is available.
- Back up Postgres. Consider an HNSW index if a single agent will hold very large amounts of content (note in
  `db/migrations/001_init.sql`).

## Layout

```
db/migrations/        SQL schema (vector size injected from EMBEDDING_DIM)
docs/                 guides (see the table above)
scripts/              migrate, preflight, unit tests, smoke-*.mjs, razorpay-setup
public/widget.js      the embeddable bubble (vanilla JS, no dependencies)
src/lib/              auth, db, env, chunking, ingestion (SSRF-safe fetch), rag, answer (shared chat pipeline),
                      providers/ (openai, anthropic, sarvam), whatsapp, meta (Embedded Signup), handoff, notify (e-mail),
                      crypto, razorpay, billing, plans/usage
src/app/api/          REST routes (agents, sources, conversations, public chat, auth, whatsapp, billing, razorpay)
src/app/              pages: landing, login/signup, dashboard, billing, agent workspace, /embed/[id]
src/components/       dashboard + chat UI
```
