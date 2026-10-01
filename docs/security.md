# Security and limits

| Protection | What it does |
| --- | --- |
| Rate limits | Chat: 20 messages a minute per visitor IP per agent. Login: 10 tries per 5 minutes. Sign-up: 10 an hour per IP. Password reset: 5 requests per 15 minutes. WhatsApp: 10 messages a minute per sender. Voice: 10 sessions a minute and 3 at once per visitor address. |
| Allowed websites | Other websites can't show an agent's chat |
| Owner-only playground | Nobody else can use the test channel, which skips handoff |
| Session reset | A password reset signs out every other session |
| Encrypted secrets | WhatsApp tokens are stored with AES-256-GCM encryption |
| Signed webhooks | Messages from Meta and Razorpay are accepted only with a valid signature, and repeats are ignored |
| Voice | Website voice needs a signed 2-minute ticket; phone streams need the agent's secret token; calls end after 15 minutes |
| Safe crawling | Private and internal addresses are refused, and pages are limited to 3 MB |
| Data isolation | Every dashboard request checks that the agent belongs to the signed-in account |
| Separate admin app | Its own sign-in, sessions and address; every change and every look at a customer's conversations is in the audit log |

## Privacy

- Customers' questions and answers are stored in the database and visible to the business owner, and to platform admins
  in answer traces and the read-only conversation view. Keep the list of admins short.
- Voice audio is sent to Sarvam for transcription and speech; only the text is stored.
- Mention AI processing, voice processing and these admin views in your privacy policy.

More in [deployment: security and privacy checklist](deployment.md#security-and-privacy-checklist).
