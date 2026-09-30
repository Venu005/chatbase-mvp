# Deploying to a server

A small VM is enough to start (2 vCPU, 2-4 GB RAM) plus a Postgres with pgvector. There are two long-running Node
processes: the customer app (`apps/web`, which also runs the ingestion worker) and the admin app (`apps/admin`), plus the
voice gateway (`apps/voice`) if you use voice agents. All read the one `.env` at the repo root.

## Checklist

1. **Postgres 15+ with pgvector**: managed service that offers it, or your own (`pgvector/pgvector:pg16` image). Create the
   database and put its URL in `DATABASE_URL` (add `?sslmode=require` for remote databases).
2. **Environment**: `cp .env.production.example .env`, fill every `REPLACE_ME`, keep `ALLOW_PRIVATE_URLS=false`, use a real
   embedding model, set `APP_URL` to your public https address, and set both `AUTH_SECRET` and `ENCRYPTION_KEY`.
   For the admin app set `ADMIN_EMAILS`, a long random `ADMIN_PASSWORD` and `ADMIN_URL` ([admin.md](admin.md)).
   Back up `ENCRYPTION_KEY` somewhere safe.
3. **Install, migrate, build, check**:
   ```bash
   pnpm install --frozen-lockfile
   pnpm migrate            # sets the embedding vector size: EMBEDDING_DIM must be final before this first run
   pnpm build
   pnpm preflight --live
   ```
4. **Run it under a supervisor** (below) and put a **TLS reverse proxy** in front.
5. **Webhooks** (only for features you use): Meta callback `APP_URL/api/whatsapp/webhook`, Razorpay webhook
   `APP_URL/api/razorpay/webhook` (see [embedded-signup.md](embedded-signup.md) and [billing-razorpay.md](billing-razorpay.md)).
6. **Backups**: schedule `pg_dump` (or your provider's backups) and test a restore.

## Process supervisor (systemd example)

```ini
# /etc/systemd/system/chatbase-india.service
[Unit]
Description=Chatbase India
After=network.target

[Service]
WorkingDirectory=/srv/chatbase-india/apps/web
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000
Restart=always
User=chatbase
Environment=NODE_ENV=production
# /srv/chatbase-india/.env (the repo root) is read by the app; keep it readable only by this user (chmod 600).

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/chatbase-india-admin.service
[Unit]
Description=Chatbase India admin
After=network.target

[Service]
WorkingDirectory=/srv/chatbase-india/apps/admin
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3001
Restart=always
User=chatbase
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/chatbase-india-voice.service (only for voice agents: docs/voice.md)
[Unit]
Description=Chatbase India voice gateway
After=network.target

[Service]
WorkingDirectory=/srv/chatbase-india/apps/voice
ExecStart=/srv/chatbase-india/apps/voice/node_modules/.bin/tsx src/server.ts
Restart=always
User=chatbase
Environment=NODE_ENV=production VOICE_PORT=3002

[Install]
WantedBy=multi-user.target
```

The services run `next start` directly (what `pnpm start` runs), so pnpm is not needed at runtime. Change `-p` to use
other ports.

## Reverse proxy (Caddy example, automatic HTTPS)

```
chat.yourdomain.in {
    reverse_proxy 127.0.0.1:3000
}

admin.yourdomain.in {
    # Optional but recommended: only let your office / VPN addresses reach the admin app.
    # @blocked not remote_ip 203.0.113.0/24
    # respond @blocked 404
    reverse_proxy 127.0.0.1:3001
}

voice.yourdomain.in {
    # WebSockets pass through; set VOICE_PUBLIC_URL=https://voice.yourdomain.in
    reverse_proxy 127.0.0.1:3002
}
```

nginx works too; make it overwrite the client address header so rate limits cannot be dodged:
`proxy_set_header X-Forwarded-For $remote_addr;`. The app trusts the first `X-Forwarded-For` value, so **only expose the app
through your own proxy**, never directly to the internet.

## Things that assume a single process

- **Rate limits are kept in memory** per process. Run one instance, or move them to Redis before scaling out.
- **Ingestion is a durable job queue in Postgres**: every server runs workers (`INGEST_CONCURRENCY`, default 2) that claim
  jobs with a lease, so several instances can run side by side and a crashed server's job is picked up again. Transient
  failures are retried with backoff (`INGEST_MAX_ATTEMPTS`, default 3). Set `INGEST_WORKER=off` on servers that shouldn't
  run jobs. Workers need a long-lived process (not serverless).
- **WhatsApp replies run in the background of the web process** after the webhook is answered. That is fine on a normal
  server; on serverless platforms move them to a queue first.
- The website widget's human-handoff polling is plain HTTP polling every 4 seconds while a person is handling a chat, so it
  needs no special proxy settings (no websockets). Voice agents do use WebSockets, on the separate voice gateway.
- **Voice sessions live in the gateway process** that took the call: restarting it ends calls in progress. Restart it
  outside busy hours; several gateways can run behind a load balancer (each call stays on one).

## Security and privacy checklist

- HTTPS everywhere; `APP_URL` starts with `https://` so cookies are marked secure.
- `ALLOW_PRIVATE_URLS=false`. URL fetching blocks private and loopback addresses but cannot fully stop DNS rebinding; for
  untrusted users put an egress proxy or firewall rules in front of the server.
- Missing on purpose in this version: e-mail verification, password reset, per-agent domain allow-listing, admin tools.
- **DPDP Act (India):** you store customers' conversations and, for WhatsApp, phone numbers. Publish a privacy notice, decide
  retention, be able to delete a person's data on request (per-conversation deletion is not built yet; deleting an agent
  deletes all of its conversations), sign data-processing terms with your AI and hosting providers, and consider an Indian
  hosting region.
- `pnpm audit` reports advisories in PostCSS bundled with Next.js 15; they concern processing untrusted CSS, which this app
  never does. Upgrade Next when a fixed release you have tested is available.
- Consider an HNSW index on `chunks.embedding` only if a single agent will hold very large amounts of content (see the note in
  `packages/core/db/migrations/001_init.sql`).

## Upgrading

`git pull && pnpm install --frozen-lockfile && pnpm migrate && pnpm build`, then restart the service. Back up first.
