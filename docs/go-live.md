# Go-live checklist

Everything to do before real customers use the platform. Details for each step are in [setup](setup.md) and
[deployment](deployment.md).

- [ ] Run a long-lived Node server (`pnpm build && pnpm start`, Docker or a VM) with Node 22.9+, pnpm 10+ and Postgres 15+
      with pgvector. The ingestion workers run inside the customer app; several servers can share the queue.
- [ ] Run `pnpm migrate`. Migrations are safe on existing data and only move forward; back up the database first.
- [ ] Set `AUTH_SECRET` and a separate `ENCRYPTION_KEY` (32+ random characters each), and back up the encryption key.
- [ ] Put each app on its address (for example `chatbase.in`, `admin.chatbase.in`, `docs.chatbase.in`,
      `voice.chatbase.in`) and set `APP_URL`, `ADMIN_URL`, `DOCS_URL` and `VOICE_PUBLIC_URL` to the `https://` addresses.
      `APP_URL` turns on secure cookies and is needed for WhatsApp and Razorpay webhooks.
- [ ] Choose real AI providers: `LLM_PROVIDER`, `LLM_MODEL`, keys and `EMBEDDING_PROVIDER=openai`. Then run
      `pnpm preflight --live`.
- [ ] Set `SMTP_URL` and `EMAIL_FROM`. Without them there are no password-reset, handoff, new-lead or alert e-mails.
- [ ] Set `SARVAM_API_KEY` for WhatsApp voice notes and voice agents (optional). For voice agents also run the voice
      gateway; for Plivo transfers set `PLIVO_AUTH_ID` and `PLIVO_AUTH_TOKEN` ([voice agents](voice.md)).
- [ ] Billing: the Razorpay keys, webhook secret, and `pnpm razorpay:setup` for the plan IDs
      ([Razorpay billing](billing-razorpay.md)). WhatsApp: the Meta app values for Connect with Facebook
      ([Embedded Signup](embedded-signup.md)).
- [ ] Tune `RETRIEVAL_MIN_SCORE` (start near 0.25 with real embeddings) and `ANSWER_FIX_MIN_SCORE` (0.5) on your own
      customers' questions.
- [ ] Set `ADMIN_EMAILS`, `ADMIN_PASSWORD` and `ADMIN_URL` for the admin app, and `LLM_PRICES` (plus
      `EMBEDDING_PRICE_PER_MTOK` and `USD_INR_RATE` for profit figures) from your providers' current price lists
      ([admin app](admin.md)).
- [ ] Add a backup model (`LLM_FALLBACK_PROVIDER` / `LLM_FALLBACK_MODEL`) from a different provider, and optionally a
      small model for small talk ([AI in production](ai-in-production.md)).
- [ ] Optional: `OCR_PROVIDER` + `OCR_MODEL` for scanned PDFs and photos, and `PRERENDER_URL` for JavaScript-built
      websites.
- [ ] Run `pnpm eval -- --save-baseline` with your production models, then `pnpm eval -- --check` before every prompt,
      search or model change ([testing](testing.md)).
- [ ] Make a test call and a test WhatsApp message on your own numbers before announcing them.
