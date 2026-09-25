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
WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:4020 \
SMTP_URL=smtp://127.0.0.1:4025 EMAIL_FROM="Bot <bot@example.com>" \
RAZORPAY_API_BASE=http://127.0.0.1:4030 RAZORPAY_KEY_ID=rzp_test_fake RAZORPAY_KEY_SECRET=fake_key_secret \
RAZORPAY_WEBHOOK_SECRET=whsec_test RAZORPAY_PLAN_STARTER=plan_starter0000001 RAZORPAY_PLAN_GROWTH=plan_growth00000001 \
META_APP_ID=app_123456 META_APP_SECRET=platform-app-secret-for-tests META_ES_CONFIG_ID=cfg_987654 \
WHATSAPP_WEBHOOK_VERIFY_TOKEN=platform-verify-token \
pnpm start

# terminal 2
pnpm smoke             # accounts, ingestion, RAG answers, isolation, limits, widget, rate limits
pnpm smoke:account     # password reset e-mails and links, allowed websites for the widget
pnpm smoke:whatsapp    # manual WhatsApp connection, webhook signatures, dedupe, replies, credits
pnpm smoke:handoff     # human handoff: inbox, replies on the widget and WhatsApp, e-mail alerts, auto-resume
pnpm smoke:embedded    # Embedded Signup: code exchange, subscribe, register, platform webhook
pnpm smoke:billing     # Razorpay checkout, signatures, webhook state machine, cancel, plan setup
pnpm smoke:sarvam      # Sarvam provider (starts its own app copy on port 3010; no app needed on 3000)
```

Run them against a scratch database, not production. They create accounts and agents with random names.
`ALLOW_PRIVATE_URLS=true` in your `.env` additionally lets `pnpm smoke` test website crawling against a local page.
