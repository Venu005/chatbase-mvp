# Setup guide and configuration reference

This guide takes you from a fresh checkout to a running app, then lists every setting. Each optional feature
(WhatsApp, billing, e-mail alerts, other AI providers) has its own guide, linked from the [README](../README.md).

## 1. What you need

| Requirement | Notes |
| --- | --- |
| Node.js 22.9 or newer | `node -v` |
| pnpm 10 or newer | `corepack enable` (the exact version is pinned in `package.json`), or `npm i -g pnpm` |
| Postgres 15+ with the **pgvector** extension | `docker compose up -d` starts a suitable one (image `pgvector/pgvector:pg16`). Managed Postgres works if it offers pgvector. |
| An AI provider account (later) | The app runs without one using built-in mock models. See [providers.md](providers.md). |

## 2. First run (about 5 minutes, no API keys)

```bash
docker compose up -d          # Postgres + pgvector
pnpm install
cp .env.example .env          # then edit .env: set AUTH_SECRET (see below)
pnpm migrate                  # creates the tables
pnpm preflight                   # checks your .env and database
pnpm dev                      # http://localhost:3000
```

Generate the two secrets with `openssl rand -base64 48`: put one in `AUTH_SECRET`, and (recommended) another in
`ENCRYPTION_KEY`. The app rejects the `REPLACE_ME` placeholder as a secret, so sign-up and login fail until you replace it.

Open http://localhost:3000, sign up, create an agent, add a website URL or paste your FAQ, and chat in the Playground.
With mock models the replies just quote your best-matching passage. Move on to [providers.md](providers.md) for real answers.

## 3. Filling in `.env` with real values

`.env.example` is written to be copied and filled in:

- An **empty** value (`KEY=`) is treated exactly like an unset variable, so you can leave features you do not use blank.
- Do not use quotes, spaces around `=`, or trailing comments on a value line.
- **`pnpm preflight`** checks the file and the database. **`pnpm preflight --live`** also makes real calls to prove that your
  AI keys, embedding dimensions, Razorpay keys and plan ids, Meta app id/secret and SMTP login work.
  `pnpm preflight --live --email you@example.com` additionally sends a test e-mail.
- On a server, start from **`.env.production.example`** instead (production defaults, https, real embeddings).

A typical order: core values, then models, then `pnpm migrate`, then `pnpm preflight --live`, then optional features one by one.

## 4. Configuration reference

"Blank" means the variable can be empty.

### Core

| Variable | Required | Default | What it is |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | | Postgres connection string, e.g. `postgres://user:pass@host:5432/db`. Add `?sslmode=require` for most managed databases. |
| `AUTH_SECRET` | yes | | 32+ random characters that sign login cookies. Changing it logs everyone out. |
| `APP_URL` | recommended | `http://localhost:3000` in links | Public address of the app, no trailing slash. Used in the embed snippet, e-mail links, WhatsApp callback URLs. Starting with `https://` turns on secure cookies. Must be public https for WhatsApp and Razorpay webhooks. |
| `ENCRYPTION_KEY` | recommended | derived from `AUTH_SECRET` | 32+ random characters that encrypt customers' WhatsApp tokens at rest. Set it once and back it up; if it changes, stored tokens cannot be read and customers must reconnect WhatsApp. |

### AI models (details in [providers.md](providers.md))

| Variable | Default | What it is |
| --- | --- | --- |
| `LLM_PROVIDER` | `mock` | `mock`, `openai` (any OpenAI-compatible API), `anthropic` or `sarvam`. |
| `LLM_MODEL` | | Model id. Required for `openai` and `anthropic`. For `sarvam` blank means `sarvam-105b`. |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | base: `https://api.openai.com/v1` | For `LLM_PROVIDER=openai`. Point the base URL at any compatible server (Ollama, vLLM, LiteLLM, a gateway). |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | base: `https://api.anthropic.com` | For `LLM_PROVIDER=anthropic`. |
| `SARVAM_API_KEY`, `SARVAM_BASE_URL` | base: `https://api.sarvam.ai/v1` | For `LLM_PROVIDER=sarvam`. |
| `SARVAM_REASONING_EFFORT` | service default | `none` (recommended for support answers), `low`, `medium` or `high`. |
| `SARVAM_MAX_TOKENS` | `1024` | Maximum length of one answer. |
| `EMBEDDING_PROVIDER` | `mock` | `mock` (development only) or `openai` (any OpenAI-compatible embeddings endpoint). |
| `EMBEDDING_API_KEY` | `OPENAI_API_KEY` | Key for the embeddings endpoint. |
| `EMBEDDING_BASE_URL` | `OPENAI_BASE_URL` | Embeddings endpoint base URL. |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model id. |
| `EMBEDDING_DIM` | `1536` | Vector size of the model. **Fixed when you first run `pnpm migrate`.** |
| `EMBEDDING_SEND_DIMENSIONS` | `false` | `true` for models that accept a `dimensions` parameter. |
| `RETRIEVAL_TOP_K` | `6` | How many passages are given to the model per question. |
| `RETRIEVAL_MIN_SCORE` | `0.2` (`0.1` in `.env.example`) | Passages scoring below this similarity are ignored. Tune per embedding model. |
| `ANSWER_FIX_MIN_SCORE` | `0.5` | How similar a visitor's question must be to a Q&A answer's question for the owner's answer to be used. Raise it if Q&A answers show up for unrelated questions. |

### WhatsApp (guides: [whatsapp.md](whatsapp.md), [embedded-signup.md](embedded-signup.md))

| Variable | Default | What it is |
| --- | --- | --- |
| `META_APP_ID` | blank | App ID of your platform's Meta app (Embedded Signup). |
| `META_APP_SECRET` | blank | Its app secret. Verifies webhook signatures and exchanges signup codes. Server side only. |
| `META_ES_CONFIG_ID` | blank | Embedded Signup configuration id. |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | blank | A random string you choose; enter the same value when Meta asks for a webhook verify token. |
| `WHATSAPP_GRAPH_VERSION` | `v25.0` | Meta Graph API version. |

Set all four `META_*`/verify-token values to enable the **Connect with Facebook** button, or none to keep only the manual
connection. Manual connections need no variables.

### Billing (guide: [billing-razorpay.md](billing-razorpay.md))

| Variable | What it is |
| --- | --- |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | API keys (`rzp_test_...` first). Blank turns billing off. |
| `RAZORPAY_WEBHOOK_SECRET` | The secret you choose when you create the webhook. Without the webhook, paid plans are never activated. |
| `RAZORPAY_PLAN_STARTER`, `RAZORPAY_PLAN_GROWTH`, `RAZORPAY_PLAN_PRO` | Plan ids printed by `pnpm razorpay:setup`. A tier without an id shows "Not available". |

### E-mail alerts (guide: [handoff.md](handoff.md))

| Variable | Default | What it is |
| --- | --- | --- |
| `SMTP_URL` | blank | e.g. `smtps://user:pass@smtp.example.com:465` or `smtp://user:pass@smtp.example.com:587`. Blank means no e-mails (handoff alerts and password reset links; in development the reset link is printed to the server log instead). |
| `EMAIL_FROM` | `Chatbase India <noreply@localhost>` | Sender. Must be an address your SMTP provider allows. |
| `HANDOFF_EMAIL_COOLDOWN_MINUTES` | `15` | At most one alert e-mail per conversation per this many minutes. |
| `HANDOFF_AUTO_RESUME_HOURS` | `24` | A customer nobody answered for this long is handed back to the assistant. `0` disables. |

### Safety and limits

| Variable | Default | What it is |
| --- | --- | --- |
| `ALLOW_PRIVATE_URLS` | `false` | Lets URL sources fetch localhost and private addresses. **Never `true` on a public server.** |
| `SIGNUP_RATE_LIMIT` | `10` | Sign-ups per IP per hour. |

Two more variables exist only for the test scripts (they redirect calls to local fake servers): `WHATSAPP_GRAPH_BASE_URL`
and `RAZORPAY_API_BASE`. Never set them in production.

## 5. Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` / `pnpm build` / `pnpm start` | Development server / production build / production server |
| `pnpm migrate` | Applies database migrations (safe to re-run) |
| `pnpm preflight [--live] [--email you@x.com]` | Checks `.env` and the database; `--live` also tests the external services |
| `pnpm razorpay:setup` | Creates the monthly INR plans in Razorpay and prints the `RAZORPAY_PLAN_*` lines |
| `pnpm typecheck` | TypeScript check |
| `pnpm test` | Unit tests (chunking, encryption, message formatting, handoff phrases, provider helpers) |
| `pnpm smoke`, `smoke:whatsapp`, `smoke:handoff`, `smoke:embedded`, `smoke:billing`, `smoke:sarvam` | End-to-end tests against fake external services. See [testing.md](testing.md). |

## 6. Upgrading

```bash
git pull            # or copy the new files
pnpm install --frozen-lockfile
pnpm migrate        # applies new migrations
pnpm build && pnpm start
```

Migrations only move forward. Back up the database before upgrading a production system.
