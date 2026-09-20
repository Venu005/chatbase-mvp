# Deploying to a server

A small VM is enough to start (2 vCPU, 2-4 GB RAM) plus a Postgres with pgvector. The app is one long-running Node process.

## Checklist

1. **Postgres 15+ with pgvector**: managed service that offers it, or your own (`pgvector/pgvector:pg16` image). Create the
   database and put its URL in `DATABASE_URL` (add `?sslmode=require` for remote databases).
2. **Environment**: `cp .env.production.example .env`, fill every `REPLACE_ME`, keep `ALLOW_PRIVATE_URLS=false`, use a real
   embedding model, set `APP_URL` to your public https address, and set both `AUTH_SECRET` and `ENCRYPTION_KEY`.
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
WorkingDirectory=/srv/chatbase-india
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p 3000
Restart=always
User=chatbase
Environment=NODE_ENV=production
# .env in the working directory is read by the app; keep it readable only by this user (chmod 600).

[Install]
WantedBy=multi-user.target
```

The service runs `next start` directly (what `pnpm start` runs), so pnpm is not needed at runtime. Change `-p 3000` to use another port.

## Reverse proxy (Caddy example, automatic HTTPS)

```
chat.yourdomain.in {
    reverse_proxy 127.0.0.1:3000
}
```

nginx works too; make it overwrite the client address header so rate limits cannot be dodged:
`proxy_set_header X-Forwarded-For $remote_addr;`. The app trusts the first `X-Forwarded-For` value, so **only expose the app
through your own proxy**, never directly to the internet.

## Things that assume a single process

- **Rate limits are kept in memory** per process. Run one instance, or move them to Redis before scaling out.
- **Website ingestion and WhatsApp replies run in the background of the web process** after the HTTP response is sent. That is
  fine on a normal server. On serverless platforms (where the process may be frozen after responding) move both to a job queue
  first.
- The website widget's human-handoff polling is plain HTTP polling every 4 seconds while a person is handling a chat, so it
  needs no special proxy settings (no websockets).

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
  `db/migrations/001_init.sql`).

## Upgrading

`git pull && pnpm install --frozen-lockfile && pnpm migrate && pnpm build`, then restart the service. Back up first.
