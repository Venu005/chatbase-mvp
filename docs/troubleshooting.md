# Troubleshooting

Start with the checker. It finds most problems in seconds and tells you the fix:

```bash
pnpm preflight            # reads .env, checks the database and the migrations
pnpm preflight --live     # also makes real calls: AI keys, embedding size, Razorpay, Meta, SMTP
```

Each line starts with a green `✓` (fine), a yellow `!` (warning) or a red `✗` (must fix). Fix every `✗`, then read the `!` lines. When something still misbehaves,
look at the server's log (the terminal running `pnpm dev`/`pnpm start`, or `journalctl -u chatbase-india`): failures
that should not be shown to customers are written there.

## Contents

- [Setup and `.env`](#setup-and-env)
- [Sources and answers](#sources-and-answers)
- [Website widget](#website-widget)
- [WhatsApp (both connection methods)](#whatsapp-both-connection-methods)
- [Embedded Signup ("Connect with Facebook")](#embedded-signup-connect-with-facebook)
- [Human handoff and e-mail alerts](#human-handoff-and-e-mail-alerts)
- [Billing (Razorpay)](#billing-razorpay)
- [Still stuck](#still-stuck)

## Setup and `.env`

**Sign-up or login shows "Something went wrong" right after you copy `.env.example`.**
The server log says `AUTH_SECRET must be set to a random string of 32+ characters`. `AUTH_SECRET` is still the `REPLACE_ME...` placeholder (or empty, or shorter than 32 characters). Generate one with
`openssl rand -base64 48`, paste it, restart. The same applies to `ENCRYPTION_KEY` if you set it: either a real secret or
blank, never the placeholder. Changing `AUTH_SECRET` later logs everyone out.

**`pnpm migrate` fails with `extension "vector" is not available`.**
Your Postgres has no pgvector. With Docker use `docker compose up -d` (it uses `pgvector/pgvector:pg16`). On managed
Postgres enable the extension in the provider's console, or run `CREATE EXTENSION vector;` as an admin. Then re-run
`pnpm migrate`.

**`pnpm migrate` or the app cannot connect (`ECONNREFUSED`, `password authentication failed`, `no pg_hba.conf entry`).**
Check `DATABASE_URL`. `ECONNREFUSED` means nothing is listening on that host and port (is the container running? `docker
compose ps`). Most managed databases need `?sslmode=require` on the URL. Special characters in the password must be
URL-encoded.

**My value has a `$` in it and the app sees something different.**
Next.js expands `$NAME` inside `.env` values (for example `pa$word` loses `$word`). Write `$` as `%24` in URLs (database
password), and for other values use characters that are not `$`. `pnpm preflight` warns when it finds a `$` in your `.env`.

**A variable I set is ignored.**
Check for quotes, spaces around `=`, or a trailing `# comment` on the value line. Also remember that an **empty** value
counts as unset. `.env` is read when the server starts, so restart after editing it (on a production server run `pnpm build` again too if you changed `APP_URL`).

**`pnpm dev` says `--env-file-if-exists` is not a valid option / unknown option.**
Your Node is older than 22.9. Check `node -v` and upgrade (`nvm install 22`). The `engines` field in `package.json` says
the same.

**pnpm complains about the version (`ERR_PNPM_UNSUPPORTED_ENGINE`, or a different pnpm is used).**
Run `corepack enable` so the pinned version in `package.json` is used, or install pnpm 10 or newer.

**Port 3000 is already in use.**
`pnpm dev -p 3001` (and set `APP_URL` to match), or stop the other process.

## Sources and answers

**A source shows "failed".**
The reason is shown next to the source in the Sources list. The usual ones:

- *`Fetching ... failed with HTTP 403/404`*: the site blocks bots or the URL is wrong. Try another page, or paste the text.
- *That address is not allowed*: the URL points at localhost or an internal network. That is blocked on purpose. For local
  development only, set `ALLOW_PRIVATE_URLS=true`; never do this on a public server.
- *No readable text found at that URL* (or *in this source*): the page is built by JavaScript in the browser, so the server fetched an empty shell, or the
  PDF is a scan (images only). Paste the text, or use a text-based PDF.
- *`expected 1536 dimensions, not 3072`* (the numbers will differ): `EMBEDDING_DIM` does not match the embedding model.
  See [the next item](#embedding-size).
- *401/invalid API key from the embeddings service*: fix `EMBEDDING_API_KEY` (or `OPENAI_API_KEY`) and add the source again.

<a id="embedding-size"></a>
**Embedding size mismatch (`expected N dimensions, not M`).**
The vector size is fixed when the `chunks` table is created by `pnpm migrate`, so `EMBEDDING_DIM` must equal what the
model returns (text-embedding-3-small: 1536; text-embedding-3-large: 3072, or 1536 with `EMBEDDING_SEND_DIMENSIONS=true`).
If you have not stored real data yet, the simplest fix is a fresh database: `docker compose down -v`, `docker compose up
-d`, correct `EMBEDDING_DIM`, `pnpm migrate`. With data you want to keep, you have to change the column and re-index
every source; see [providers.md](providers.md#the-vector-size-is-permanent). `pnpm preflight --live` checks this for you.

**The assistant answers "I don't know" or ignores my content.**
Retrieval found nothing above `RETRIEVAL_MIN_SCORE`. With `EMBEDDING_PROVIDER=mock` this happens constantly, because the
mock only matches shared words: switch to real embeddings. With real embeddings, lower `RETRIEVAL_MIN_SCORE` (try 0.15),
or check that the source is `ready` and actually contains the answer. Ask the question in the Playground and open the
citations to see what was retrieved.

**Answers are just a quote from my document.**
`LLM_PROVIDER` is still `mock`. Set a real provider and `LLM_MODEL`, restart.

**Answers are in the wrong language, or mixed.**
The assistant is told to answer in the customer's language. If it does not, add a line to the agent's instructions (for
example "Reply in the language of the customer's message; for Hinglish reply in Hinglish"), and see the Indian-language
tips in [providers.md](providers.md).

**Sarvam: replies contain reasoning text, or they are slow.**
Set `SARVAM_REASONING_EFFORT=none` (the value in `.env.example`). The app also strips `<think>...</think>` blocks from the
stream, but turning reasoning off is faster and cheaper.

**`LLM request failed (401/404/429 ...)` in the log or the chat.**
401: wrong key. 404: wrong `LLM_MODEL` for that provider, or a wrong `*_BASE_URL`. 429: your provider account has hit its
rate limit or is out of credit. `pnpm preflight --live` sends one tiny request and prints the provider's own message.

**"This assistant has reached its monthly message limit" (HTTP 402).**
The account's plan credits are used up (see `src/lib/plans.ts`). Upgrade the plan in **Plans & billing**, or raise the
limits in `plans.ts`. A message costs one credit and is refunded if generation fails. While a conversation is with a human
(see below) the bot uses no credits.

**"You're sending messages too quickly" (429).**
The per-visitor limit is 20 chat messages a minute per agent. The counters are in memory and reset on restart.

## Website widget

**The bubble does not appear on my site.**
Open the browser's developer console (F12). Then check, in order:

1. The snippet is exactly `<script src="https://YOUR-APP/widget.js" data-agent-id="AGENT_ID" defer></script>` with your real
   address and the agent's id (Agent page, Embed tab).
2. Your site is `https://` but the app address is `http://`. Browsers block that ("mixed content"). Serve the app over https
   and set `APP_URL` to it.
3. `https://YOUR-APP/widget.js` opens in a browser tab. If it does not, the app is unreachable from the internet.
4. A content-security-policy on your site blocks the script or the frame. Allow your app's address in `script-src` and
   `frame-src`.

**The bubble opens but shows an error.**
Open `https://YOUR-APP/embed/AGENT_ID` in a tab. If that page works, the problem is between your site and the app
(usually the checks above). If it also fails, see the server log.

**After a page reload the conversation is gone.**
It is restored from the server using a per-browser id in `localStorage`. Private windows and blocked site data lose it.
That is expected.

## WhatsApp (both connection methods)

**Saving the connection says "WhatsApp rejected these credentials".**
The Phone number ID is not the phone number: it is a long number in Meta's API Setup page. The token must be one that can
use that number (a System User token with `whatsapp_business_messaging`, or the temporary token from API Setup). The message
that follows is Meta's own; error code 190 means the token is invalid or expired.

**Meta's "Verify and save" for the webhook fails (manual connection).**
Meta calls `APP_URL/api/whatsapp/webhook/<channel id>` and expects your verify token back. Check:

- The Callback URL and Verify token are exactly the ones shown in the dashboard's WhatsApp tab (no spaces).
- `APP_URL` is the public https address. A `localhost` address cannot be reached by Meta: use a tunnel (ngrok, Cloudflare
  Tunnel) and set `APP_URL` to it, then reconnect so the shown URL is correct.
- The app is running and reachable. Test with `curl "https://YOUR-APP/api/whatsapp/webhook/<channel id>?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=123"`; it must answer `123`.

**Meta's verification fails (Embedded Signup / platform webhook).**
Same test against `APP_URL/api/whatsapp/webhook` with `hub.verify_token=<WHATSAPP_WEBHOOK_VERIFY_TOKEN>`. If it answers
`Forbidden` (403), the token in Meta and in `.env` differ, or the server was not restarted after you set it.

**Verified, but I message the number and nothing comes back.**
Work through this list; the server log tells you which step fails.

1. Did you **subscribe to the `messages` field** in the Meta app's webhook settings? (Manual connections: yes, you must.
   Embedded Signup: the app subscribes for you.)
2. Does a `POST` reach the app? If the log shows nothing at all, Meta is not sending: wrong Callback URL, or the app is in
   development mode and your sending phone is not a tester/added number.
3. `Invalid signature` (HTTP 401 in the server log or Meta's webhook log): the **App secret** is wrong. For a manual
   connection, re-enter it (Meta app, Settings, Basic). For the platform webhook it is `META_APP_SECRET`.
4. The answer is generated but sending fails: see the next item.
5. The number's conversation is in **human mode** (a person took over): the bot is silent on purpose. Open the Chats tab
   and click **Hand back to assistant**.
6. The account is out of credits (402): the customer gets the limit message; upgrade the plan.

**Sending fails: Graph error 131047 ("re-engagement message") or "more than 24 hours".**
WhatsApp only allows free-form messages within 24 hours of the customer's last message. The assistant only replies to
incoming messages, so it is always inside the window. The error appears when an owner replies from the dashboard to a
customer who last wrote more than 24 hours ago: the reply is refused, nothing is saved, and you see the error. Ask the
customer to message again, or send an approved template message from Meta's tools (templates are not built into this app).

**Graph error 131030 ("recipient not in allowed list").**
A Meta test number can message only phone numbers you have added and verified in API Setup. Add the recipient there.

**Graph error 190 or "access token expired" after it worked yesterday.**
You are using the temporary 24-hour token. Create a permanent System User token, or use Embedded Signup. Reconnect with the
new token.

**"This WhatsApp number is already connected to another agent" (409).**
One number can be connected to one agent at a time (in the whole system). Disconnect it from the other agent first.

**Customers see "I can only read text messages".**
Voice notes, images and other media are not processed in this version. The assistant asks the customer to type. In human
mode, media is recorded in the inbox as a placeholder.

**Long answers arrive as several messages.**
WhatsApp limits one message to 4096 characters; longer answers are split at paragraph boundaries. Tell the assistant to be
brief in the agent instructions if that is too much.

## Embedded Signup ("Connect with Facebook")

Also read [embedded-signup.md](embedded-signup.md), which lists what Meta requires.

**The "Connect with Facebook" button does not appear (only the manual form).**
The server needs all four values: `META_APP_ID`, `META_APP_SECRET`, `META_ES_CONFIG_ID` and
`WHATSAPP_WEBHOOK_VERIFY_TOKEN`. If any is blank the button is hidden. Restart after setting them, then `pnpm preflight`.

**Clicking the button opens nothing, or a blank/"URL blocked" popup.**
In the Meta app: Facebook Login for Business (or Facebook Login), Settings: add your domain to **Allowed domains for the
JavaScript SDK** and to **Valid OAuth redirect URIs**, and turn on **Login with the JavaScript SDK**. The page must be
served over **https** (localhost is fine only through an https tunnel; Meta rejects plain http). Also disable
pop-up blockers and tracking blockers that block `connect.facebook.net`.

**The popup finishes but the dashboard shows "Meta rejected the signup code".**
The one-time code expires after about 30 seconds and can be used once. Click the button again and finish the popup
promptly. If it repeats, check `META_APP_ID` / `META_APP_SECRET` belong to the same app that owns the configuration id.

**"That phone number does not belong to the WhatsApp account Meta reported."**
Safety check: the number id and the WhatsApp Business Account id from the popup did not match. Try again; if it persists,
finish the popup completely (choose or add a number and verify it) instead of closing it early.

**"Couldn't subscribe to this WhatsApp account's messages" (502).**
Meta refused to let the app receive this account's messages. The connection is not saved. Check that the app has the
`whatsapp_business_management` and `whatsapp_business_messaging` permissions (App Review may be needed for customers'
accounts) and that the customer completed the signup as an admin of the Business.

**Connected, but messages do not arrive.**
The platform webhook is set once per Meta app: App Dashboard, WhatsApp, Configuration, Callback URL
`APP_URL/api/whatsapp/webhook` with your `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, and the `messages` field subscribed. Embedded
numbers use this webhook, not a per-channel one.

**The number could not be registered.**
Registration failure is shown as a warning and does not block the connection. If the number is already active on the
WhatsApp Business app or another provider you may need to complete that migration in Meta's tools first.

## Human handoff and e-mail alerts

**The owner is not e-mailed.**
Run `pnpm preflight --live --email you@example.com`: it verifies the SMTP login and sends a real test message. Typical causes:

- `SMTP_URL` blank: no e-mails by design; conversations still show in the dashboard (Chats tab, "N waiting").
- Wrong credentials, or the wrong port/security: port 465 uses `smtps://`, port 587 uses `smtp://` (STARTTLS).
- Special characters in the SMTP password must be URL-encoded (`@` is `%40`, `$` is `%24`).
- Gmail needs an **app password**; SES needs a verified sender.
- `EMAIL_FROM` is not an address the provider allows: many providers reject or silently drop mail from other domains.
- E-mails are rate limited on purpose: at most one per conversation per `HANDOFF_EMAIL_COOLDOWN_MINUTES` (15). The first
  handoff and the first contact-details capture always send.
- The agent's Settings has "E-mail me when a customer is waiting for a reply" switched off.
- Check spam folders. Failures are logged as `Handoff e-mail failed: ...`.

**The e-mail link opens the wrong address.**
The link is built from `APP_URL`. Set it to the public address and restart.

**The button "Talk to a human" is missing in the widget.**
Handoff is off for the agent (Settings tab), or the visitor is in the Playground (the playground never hands off). The
widget reads the setting when it loads, so refresh the page after changing it.

**The customer typed "agent" and the bot answered normally.**
Phrase detection is deliberately conservative (English, Hindi and Hinglish phrases such as "talk to a human", "insaan se
baat karni hai"). A single word like "human" or "agent" only counts when it is the whole message. Customers can always use
the button; on WhatsApp they can type one of the phrases.

**The bot stays silent forever.**
That is what human mode does. Click **Hand back to assistant**, or reply. After `HANDOFF_AUTO_RESUME_HOURS` (24) with no
reply from you the bot takes over again; set it to `0` to disable that.

**My dashboard reply to a WhatsApp customer failed.**
The reply is only saved when WhatsApp accepted it, so a failure leaves nothing behind. The message shows Meta's reason
(24-hour window, expired token, not connected anymore). See [WhatsApp](#whatsapp-both-connection-methods).

## Billing (Razorpay)

**"Billing isn't set up on this server yet" (503).**
`RAZORPAY_KEY_ID` or `RAZORPAY_KEY_SECRET` is blank. Blank means billing is off by design.

**"The Starter plan isn't available yet" / a plan says "Not available".**
The matching `RAZORPAY_PLAN_*` variable is blank. Run `pnpm razorpay:setup` and paste the lines it prints. Plan ids
created in test mode do not exist in live mode: run the setup again with live keys.

**Razorpay error 401 / "Authentication failed".**
Key id and secret do not belong together, or you mixed test and live. `pnpm preflight --live` checks the keys.

**I paid in test mode but the plan did not change.**
Only the signed webhook changes a plan. Check in the Razorpay Dashboard, Webhooks, that a webhook exists for
`APP_URL/api/razorpay/webhook` with the events listed in [billing-razorpay.md](billing-razorpay.md), that the secret equals
`RAZORPAY_WEBHOOK_SECRET`, and look at the webhook's delivery log. A `401 Invalid signature` there means the secrets differ.
Razorpay cannot reach `localhost`: use a tunnel.

**After cancelling, the plan is still active.**
Correct: a paid plan stays until the end of the period that was paid for. Confirm the exact timing in test mode before
launch (see the note in [billing-razorpay.md](billing-razorpay.md)).

**"You already have an active subscription. Cancel it first to switch plans."**
Plan changes are cancel-and-resubscribe in this version.

## Still stuck

1. Run `pnpm preflight --live` and read every `✗` and `!` line.
2. Read the server log around the time of the problem.
3. Run the matching smoke test (`pnpm smoke:whatsapp`, `smoke:handoff`, `smoke:embedded`, `smoke:billing`,
   `smoke:sarvam`). They use fake external services, so if they pass and the real thing fails, the problem is in the
   configuration or in the external account rather than in the app. See [testing.md](testing.md).
4. Remember that the code has been tested only against fake versions of Meta, Razorpay, OpenAI, Anthropic and Sarvam. If a
   real service behaves differently from its documentation, the log line with the service's own error message is the most
   useful thing to look at.
