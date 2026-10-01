# Known limits and next steps

## Known limits

- Rate limits live in one server's memory; more than one server needs Redis for them. (Ingestion is a shared Postgres
  queue.)
- The visitor IP is taken from `X-Forwarded-For`, which is only safe behind your own proxy.
- Connect with Facebook, voice notes and voice agents were tested against fake Meta, Sarvam, Plivo and Exotel servers that
  follow their documented formats, not live accounts. Test with your own numbers first.
- Sarvam's instant speech-to-text takes clips under about 30 seconds; longer WhatsApp voice notes get a "please type"
  reply.
- Voice sessions live in the gateway process that took the call, so restarting it ends calls in progress.
- The assistant doesn't read WhatsApp images. The inbox lists 100 conversations, with no search.
- The reranker, follow-up rewriting, OCR and page rendering were tested against fake services only, and the quality
  numbers come from mock models. Run `pnpm eval` with real models before switching the optional steps on.

## Suggested next features

- **Team members** who can reply from the inbox without the owner's login.
- **Actions**: order status from Shopify or WooCommerce, appointment booking, UPI payment links.
- **WhatsApp templates**, for replies after 24 hours and opt-in offers.
- **Streaming speech** (Sarvam's streaming speech-to-text and text-to-speech) to shave a few hundred milliseconds off voice
  replies, and **outbound calls** to call back leads.
- **Credit top-ups**, GST invoices, and data export and deletion for India's DPDP Act.
