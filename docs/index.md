# Chatbase India documentation

Chatbase India is an AI support assistant for Indian small businesses. You train it on your website, PDFs, spreadsheets
and FAQs. It answers your customers on your website, on WhatsApp and on phone calls, by text or by voice, in Hindi,
Hinglish, English and other Indian languages. When it can't answer, a person from your team takes over.

These docs are for two kinds of readers:

- **Business owners** who use the dashboard: start with [your first day](guide/getting-started.md), then read about
  [teaching the assistant](guide/sources.md) and [putting it on your website](guide/website-chat.md).
- **Whoever runs the platform** (developers and operators): start with [setup](setup.md) and
  [deployment](deployment.md), then the [go-live checklist](go-live.md).

## What it does

Each agent (one assistant) has its own tabs in the dashboard: Sources, Q&A, Playground, Settings, Embed, WhatsApp, Voice,
Chats, Leads and Analytics.

| Area | Feature | Where |
| --- | --- | --- |
| Teach | Knowledge sources: websites, PDF, TXT, MD and CSV files, pasted text; read by their structure, refreshed weekly | [Sources](guide/sources.md) |
| | Q&A answers and "Fix this answer" | [Q&A answers](guide/qa-answers.md) |
| | Owner-only test chat | [Playground](guide/playground-and-settings.md) |
| Channels | Website chat bubble and full-page chat link, limited to your own websites | [Website chat](guide/website-chat.md) |
| | WhatsApp, including transcribed voice notes | [WhatsApp](guide/whatsapp.md) |
| | Voice: talk on the website, answer phone calls | [Voice](guide/voice.md) |
| Conversations | Inbox, human handoff, e-mail alerts, 👍 / 👎 on answers | [Inbox and handoff](guide/inbox-and-handoff.md) |
| Growth | Lead capture and CSV export | [Leads](guide/leads.md) |
| | Analytics and knowledge gaps | [Analytics](guide/analytics.md) |
| Account | Plans, message credits, Razorpay subscriptions, password reset | [Plans and billing](guide/plans-and-billing.md) |
| Platform | Reliability, search quality, cost controls, evaluation | [AI in production](ai-in-production.md) |
| | Admin app: revenue, growth, quality, operations, alerts, audit log | [Admin app](admin.md) |

## The apps

The platform is four small apps that share one database and one `.env` file:

| App | Example address | What it is |
| --- | --- | --- |
| Customer app (`apps/web`) | `https://chatbase.in` | Sign-up, the dashboard, the chat widget, WhatsApp and billing webhooks |
| Admin app (`apps/admin`) | `https://admin.chatbase.in` | For the platform's operators: accounts, revenue, quality, alerts |
| Docs (`apps/docs`) | `https://docs.chatbase.in` | This site |
| Voice gateway (`apps/voice`) | `https://voice.chatbase.in` | Voice conversations on the website and phone calls (optional) |

See [deployment](deployment.md) for how to put them on their addresses.
