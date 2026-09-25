# WhatsApp channel

An agent can answer customers on a WhatsApp Business number, using the same knowledge, message credits and conversation
history as the website chat.

There are two ways to connect a number. You can offer both.

| | **Connect with Facebook** (Embedded Signup) | **Manual** |
| --- | --- | --- |
| Customer effort | Click a button, log in to Facebook, pick or create a WhatsApp number | Copy a Phone number ID, an access token and an app secret from their own Meta app |
| You need | A Meta app with Embedded Signup approved for your business ([embedded-signup.md](embedded-signup.md)) | Nothing extra |
| Webhook set up in Meta | Once, by you | By each customer |
| Environment variables | `META_APP_ID`, `META_APP_SECRET`, `META_ES_CONFIG_ID`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | none |

Both need `APP_URL` to be a public **https** address (use ngrok or Cloudflare Tunnel while developing).

## Manual connection

Prerequisites: a Meta developer app with the **WhatsApp** product, a WhatsApp Business phone number, and an access token.
The temporary 24-hour token on the API Setup page is fine for a first test; use a permanent System User token
(permission `whatsapp_business_messaging`) for real use.

1. Agent page, **WhatsApp** tab. Enter the **Phone number ID**, the **access token** and the **App secret**
   (Meta app, Settings, Basic). The app checks the token against Meta before saving.
2. The tab then shows a **Callback URL** and a **Verify token**. In the Meta app, WhatsApp, Configuration, Webhook, paste
   both, click *Verify and save*, and subscribe to the **messages** field.
3. Message the number from another phone.

## What customers experience

- Text messages get the assistant's answer, formatted for WhatsApp (bold as `*bold*`, no headings, up to two source links).
  Long answers are split into several messages.
- **Voice notes** are transcribed with Sarvam speech-to-text (Hindi, English and other Indian languages, detected
  automatically) when `SARVAM_API_KEY` is set, then answered like typed text. The inbox shows the transcript marked 🎤.
  Voice notes longer than about 30 seconds, or ones that can't be understood, get a "please type it" reply.
- Every WhatsApp customer is saved in the **Leads** tab with their number and WhatsApp profile name.
- Images and other media get a polite "I can only read text" reply, unless a person is handling the chat
  (then the owner sees a note that media arrived, see [handoff.md](handoff.md)).
- Typing `human`, `agent`, or a phrase like "talk to a person" or "insaan se baat karni hai" hands the chat to the owner.
- Each sender is limited to 10 messages a minute; extra messages are ignored.
- Every answer uses one message credit, the same as the website chat.

## How it works

```
Customer -> WhatsApp -> Meta -> POST /api/whatsapp/webhook[/<channel id>]
   verify X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret)
   answer 200 immediately
   skip message ids already seen (Meta delivers at least once)
   retrieve + generate (same code as the website chat)
   POST /<phone number id>/messages with the customer's token -> Meta -> Customer
```

Manual channels each have their own callback URL (`/api/whatsapp/webhook/<channel id>`) and their own app secret.
Embedded Signup channels share one platform callback (`/api/whatsapp/webhook`); messages are routed to the right agent by
phone number id and verified with `META_APP_SECRET`.

Access tokens, app secrets and registration PINs are encrypted in the database (AES-256-GCM, key from `ENCRYPTION_KEY`) and
are never sent back to the browser.

## Things to know

- **24-hour window.** WhatsApp only allows free-form messages within 24 hours of the customer's last message. The assistant
  only ever replies to a message, so it is always inside the window. An owner replying from the dashboard after 24 hours
  will get an error from WhatsApp (shown in the dashboard, and the reply is not recorded as sent). Sending first requires
  approved message templates, which this app does not implement yet.
- **Costs.** Meta charges per conversation/message category and changes its pricing; check its current price list before you
  set plan prices. Your AI provider also charges per answer.
- **Privacy.** The customer's phone number is stored as the conversation id and shown to the owner. Under India's DPDP Act
  that is personal data: publish a privacy notice, decide how long conversations are kept, and be ready to delete them on
  request (the dashboard deletes a whole agent with all of its conversations; per-conversation deletion is not built yet).
- **Not verified live.** The webhook and send code follow Meta's documented formats and were tested against a fake Meta
  server, not a live account.

See [troubleshooting.md](troubleshooting.md) for webhook and delivery problems.
