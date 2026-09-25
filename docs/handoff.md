# Human handoff

The assistant answers most questions, but sometimes a customer needs a person: a complaint, a custom order, something the
assistant cannot answer. Handoff lets the customer ask for a person, alerts you, and lets you reply from the dashboard while
the assistant stays quiet.

## What the customer can do

| Channel | How they ask for a person |
| --- | --- |
| Website chat | Click **Talk to a human** under the chat, or type a phrase such as "I want to talk to a human", "connect me to an agent", "call me", "मुझे किसी इंसान से बात करनी है", "manager se baat karao" |
| WhatsApp | Type `human` or `agent`, or the same phrases as above |
| Either | The assistant's instructions tell it to mention this option when it cannot answer, so customers learn how to ask |

They then see your **handoff message** (default: "I have asked a member of our team to help you. They will reply here as soon
as they can."). On the website they are also offered a box to leave a phone number or e-mail in case they close the window.
Asking for a person is free: it uses no message credit.

## What you see

- **E-mail** (if configured, see below): "A customer is waiting for a reply", with their contact, their latest message and a
  link straight to the conversation. At most one e-mail per conversation per 15 minutes, plus one when a customer leaves
  contact details.
- **Dashboard**: a red "N customers waiting" tag on the agent card, "N waiting" on the **Chats** tab, and "Needs reply" on the
  conversation. The Chats tab refreshes on its own.
- **Reply**: open the conversation, type in the reply box, **Send reply**. On the website the customer's chat picks it up within
  a few seconds. On WhatsApp it is sent to the customer's WhatsApp.
- **Take over / Hand back to assistant**: replying takes the conversation over automatically. Use **Hand back to assistant**
  when you are done; the assistant then answers again. You can also click **Take over** on any conversation to stop the
  assistant without waiting for the customer to ask.

While a person is handling a conversation the assistant does not answer, uses no credits, and every new customer message is
flagged "Needs reply". WhatsApp voice notes appear as their transcript marked 🎤 (when Sarvam speech-to-text is set up);
images and other media appear as a note that media arrived (open WhatsApp on your phone to view them).

## Settings (agent, Settings tab)

- **Let customers ask for a human**: turns the button, the phrase detection and the instruction to the assistant on or off.
  (Conversations you already took over stay with you.)
- **Handoff message**: what the customer sees.
- **E-mail me when a customer is waiting**: alert e-mails on or off for this agent.

The dashboard **Playground** never hands off, so you can test answers without triggering alerts. To test handoff, open the chat
page (`/embed/<agent id>`) in another browser window.

## E-mail alerts setup

Set `SMTP_URL` and `EMAIL_FROM` in `.env`, e.g. (URL-encode special characters in the password, `@` becomes `%40`):

```
SMTP_URL=smtps://alerts%40yourdomain.in:APP_PASSWORD@smtp.example.com:465
EMAIL_FROM=Chatbase India <alerts@yourdomain.in>
```

Any SMTP service works (Amazon SES, Brevo, Zoho, a Gmail app password, ...). The sender address must be one your provider
allows. Check with `pnpm preflight --live --email you@example.com`, which logs in and sends a test message. The e-mail goes to the
address the business owner signed up with. Without `SMTP_URL` handoff still works; you just have to look at the dashboard.

## Rules that keep it safe

- **Nobody is ignored forever.** If a customer has been waiting for a reply for `HANDOFF_AUTO_RESUME_HOURS` (default 24) the
  assistant takes the conversation back on their next message. Set `0` to turn this off.
- **No e-mail floods.** `HANDOFF_EMAIL_COOLDOWN_MINUTES` (default 15) limits alerts per conversation.
- **Tenant isolation.** Only the agent's owner can read, reply to, or change a conversation. The website widget can only see
  messages of its own random session id.
- **A WhatsApp reply that WhatsApp refuses is not recorded as sent.** Usually this means the customer's last message was more than
  24 hours ago; the dashboard shows WhatsApp's error.

## Limits of this version

- There is no "online now" detection: the customer is always told the team will reply when they can. Leave the contact box
  enabled so you can call back.
- Phrase detection covers English, Hindi and Hinglish. Other languages rely on the website button or on typing `human`. To
  add phrases, edit `src/lib/handoff-intent.ts` and add cases to `scripts/unit-tests.mjs`.
- One owner per agent: no team inbox, assignment or internal notes yet.
- Dashboard replies are plain text. Media replies and WhatsApp template messages are not supported.
