# Testing

Nothing here needs real API keys: the external services (Meta, Razorpay, SMTP, Sarvam) are replaced by small fake servers
that the test scripts start themselves. **These tests prove our code handles the documented API shapes; they do not prove
the live services accept your accounts.** Use `pnpm preflight --live` and the go-live checklists in each guide for that.

## Unit tests (no database, no server)

```bash
pnpm test
```

## End-to-end smoke tests

They need Postgres migrated, and a production build of the app running with the mock models.

```bash
pnpm build
# terminal 1: start the app with the fake-service settings the scripts expect
SIGNUP_RATE_LIMIT=1000 \
LLM_FIRST_TOKEN_TIMEOUT_MS=2000 LLM_FALLBACK_PROVIDER=mock LLM_FALLBACK_MODEL=backup INGEST_RETRY_BASE_MS=1000 \
LLM_SMALL_PROVIDER=mock LLM_SMALL_MODEL=small \
ADMIN_EMAILS=admin@smoke.test \
WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:4020 \
SARVAM_API_KEY=sarvam-test-key SARVAM_STT_URL=http://127.0.0.1:4020/speech-to-text \
SMTP_URL=smtp://127.0.0.1:4025 EMAIL_FROM="Bot <bot@example.com>" \
RAZORPAY_API_BASE=http://127.0.0.1:4030 RAZORPAY_KEY_ID=rzp_test_fake RAZORPAY_KEY_SECRET=fake_key_secret \
RAZORPAY_WEBHOOK_SECRET=whsec_test RAZORPAY_PLAN_STARTER=plan_starter0000001 RAZORPAY_PLAN_GROWTH=plan_growth00000001 \
META_APP_ID=app_123456 META_APP_SECRET=platform-app-secret-for-tests META_ES_CONFIG_ID=cfg_987654 \
WHATSAPP_WEBHOOK_VERIFY_TOKEN=platform-verify-token \
pnpm start

# terminal 2
pnpm smoke             # accounts, ingestion, RAG answers, isolation, limits, widget, rate limits
pnpm smoke:ai          # AI pipeline: retries, timeouts, backup model, usage and cost records, admin view
pnpm smoke:features    # 👍/👎 feedback, Q&A answers, analytics, lead capture and CSV
pnpm smoke:account     # password reset e-mails and links, allowed websites for the widget
pnpm smoke:whatsapp    # manual WhatsApp connection, webhook signatures, dedupe, replies, credits
pnpm smoke:handoff     # human handoff: inbox, replies on the widget and WhatsApp, e-mail alerts, auto-resume
pnpm smoke:embedded    # Embedded Signup: code exchange, subscribe, register, platform webhook
pnpm smoke:billing     # Razorpay checkout, signatures, webhook state machine, cancel, plan setup
pnpm smoke:sarvam      # Sarvam provider (starts its own app copy on port 3010; no app needed on 3000)
```

Run them against a scratch database, not production. They create accounts and agents with random names.
`ALLOW_PRIVATE_URLS=true` in your `.env` additionally lets `pnpm smoke` test website crawling against a local page.

## Answer-quality evaluation

`pnpm eval` runs a dataset of real customer questions through the actual answer pipeline (retrieval, prompt, model, retries)
with the models in your `.env`, and scores it. It needs only the database, not a running server: it creates a temporary
account and agent, indexes the dataset's sources, asks every question as a new visitor, then deletes the account.

```bash
pnpm eval                            # eval/datasets/kirana.json: 32 questions in English, Hindi and Hinglish
pnpm eval -- --save-baseline         # remember these scores for this dataset + model combination
pnpm eval -- --check                 # exit 1 if any rate is >5 points below the baseline (use in CI)
pnpm eval -- --judge                 # also grade groundedness with EVAL_JUDGE_PROVIDER / EVAL_JUDGE_MODEL
pnpm eval -- --only sku,hinglish     # only some categories (or question ids)
```

| Score | Meaning |
| --- | --- |
| hit@k, top1, MRR | The passage that holds the answer was among those given to the model (top1: it came first) |
| answer | The reply contains an expected fact (a price, a time...) and doesn't decline |
| refuse | For questions the sources don't cover, the assistant says it doesn't know instead of inventing |
| lang | The reply uses the customer's script (Devanagari for Hindi, Latin for English and Hinglish) |
| grounded | (`--judge`) A grader model found no claims the passages don't support |

Results are printed by category (direct, paraphrase, product code, product, follow-up, Hinglish, Hindi, out of scope) and
saved to `eval/results/`. Baselines live in `eval/baselines/`, one per dataset and model combination. **Only numbers from real
models mean anything**: the mock embeddings match shared words, so paraphrases and Hinglish fail by design. Run it with your
production models before and after every prompt, retrieval or model change, and add your customers' real questions to a
dataset of your own (same JSON format).
