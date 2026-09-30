# Admin app

A separate platform-operator dashboard (`apps/admin`): every account, every AI call, what it cost and what went wrong. It
runs on its own port (3001 locally) with its own sign-in, apart from the customer app, so you can put it on its own
address (for example `admin.yourdomain.in`) and restrict who can reach it at your proxy.

## Access

Admins are **not** customer accounts. They sign in at the admin app's `/login`, and their sessions don't work in the
customer app (and customer sessions don't work here).

**The first admins** come from the environment:

```
ADMIN_EMAILS=you@yourcompany.in, cofounder@yourcompany.in
ADMIN_PASSWORD=REPLACE_ME_with_output_of_openssl_rand_base64_24    # 12+ characters
ADMIN_URL=https://admin.yourdomain.in                              # https turns on secure cookies
```

Each `ADMIN_EMAILS` address signs in with `ADMIN_PASSWORD`. Removing an address from `ADMIN_EMAILS` (or blanking
`ADMIN_PASSWORD`) and restarting ends that access, unless that admin also set their own password.

**More admins** are added in the app: open the **Admins** tab, enter their e-mail, name and a first password (12+
characters), and share the password with them privately. Every admin can add and remove admins, except that nobody can
remove themselves and `ADMIN_EMAILS` admins are managed in the environment only. A removed admin is signed out at once.
Passwords are stored as bcrypt hashes in the `admins` table. Any admin can change their own password in the same tab,
which signs out their other sessions.

The same actions as API calls (signed in as an admin):

| Call | Does |
| --- | --- |
| `GET /api/admin/admins` | list admins (including `ADMIN_EMAILS` entries that haven't signed in yet) |
| `POST /api/admin/admins` `{ email, name?, password }` | add an admin (409 if the e-mail already is one) |
| `DELETE /api/admin/admins/{id}` | remove an admin |
| `POST /api/admin/me/password` `{ currentPassword, newPassword }` | change your own password |

Sign-in attempts are rate-limited per IP address. Admin sessions last 12 hours.

The admin app shows customers' questions and the assistant's answers (in the answer traces). Keep the list of admins to
people who need it, and mention this processing in your privacy policy.

## What it shows

Pick **Today**, **7**, **30** or **90 days** (Indian time). Owners' playground tests are left out of the numbers.

| Tab | What you see |
| --- | --- |
| **Overview** | Active, new and paying accounts; answers and conversations; failed answers (with cut-off and backup-model counts); time to the first word (average and p95); AI cost in USD and rupees, per answer; helpful rate and share of answers with nothing found in the sources. Charts of answers and cost per day. The top accounts. |
| **Business** | MRR and ARR (paid plans only; plans an admin set by hand are "comped" and not revenue), paying and comped accounts, average revenue per account, AI cost and gross margin over the last 30 days, revenue at risk (subscriptions cancelling or with failing renewals), new paid and churned subscriptions in the period. The plan mix with MRR, AI cost and margin per plan, and **profit per account** (plan price minus AI cost, worst first) so unprofitable accounts stand out. |
| **Growth** | The signup funnel for accounts that signed up in the period (created an agent → added knowledge → got a real conversation → paying); weekly cohorts (share of each signup week's accounts still getting real conversations 0–7 weeks later); **paying accounts at risk** with the reasons (cancelling, payment failing, no conversations for 10+ days, usage down by half, many unanswered questions or 👎); **upgrade candidates** (80 % of this month's credits used, or on course to run out). |
| **Quality** | Across all agents: the languages visitors write in (English, Hinglish, Hindi and other Indian scripts), topics (prices, delivery, returns, order status, payment, hours…) with how often each goes unanswered, the most asked questions and most common knowledge gaps, channels (with hand-offs to a person), busy hours by weekday in India time, and a 0–100 **health score** per agent with its issues. |
| **Accounts** | Every account: plan, credits used this month (the bar turns red above 90 %), agents, conversations, answers, failed answers, 👎, AI cost, last activity. Click one for its agents (sources, passages, Q&A answers, channels, knowledge-gap rate, leads, cost), its latest AI calls, and the **actions** below. |
| **Problems** | Answers that failed, were cut off, needed retries, or were written by the backup model, with the error. |
| **Operations** | Alerts firing now (and **Check now**), answer-cache hit rate, time for new sources to become ready, per-day answers, failure rate, backup-model share and first-word p50/p95 for each provider; then calls, tokens and cost per model, the ingestion queue, and the embedding model status with **Re-index**. |
| **Audit log** | Every admin action: plan changes, credit grants, conversations read, admins added or removed, re-indexing. |

### Actions on an account

- **Change plan**: sets the plan by hand, with a reason (a trial, a partner, a goodwill upgrade). Paid plans set this way are
  *comped*: they aren't counted as revenue, and the account's next Razorpay payment event replaces them. You're warned when
  the account has a live subscription.
- **Grant credits**: adds bonus credits for this month on top of the plan's (a negative number takes them back), with a reason.
- **Show conversations**: the account's latest conversations and their messages, read-only, for support. Each look is
  written to the audit log, because these are the customer's visitors' messages.

### Alerts

The customer app checks every 5 minutes (`ALERT_CHECK_MS`) over the last 15 minutes (`ALERT_WINDOW_MINUTES`) and e-mails
the admins (or `ALERT_EMAILS`) through `SMTP_URL`, at most once an hour per alert (`ALERT_COOLDOWN_MINUTES`):

| Alert | When (defaults) |
| --- | --- |
| Answers failing (critical) | more than 5 % of answers failed (`ALERT_ERROR_RATE`), with at least 20 answers (`ALERT_MIN_ANSWERS`) |
| Slow answers | the 95th-percentile time to the first word is above 8 s (`ALERT_P95_MS`) |
| Backup model | the backup model wrote more than 30 % of answers (`ALERT_FALLBACK_RATE`) |
| Ingestion stuck (critical) | a source has waited over 30 minutes to be read (no worker running?) |
| Sources failing | 5 or more sources failed to load (`ALERT_FAILED_SOURCES`) |

Firing alerts also show as a red banner at the top of the admin app. `ALERTS=off` stops the checks (the test setup uses it).

**Answer trace**: click any answer (in Problems or an account's latest calls) to see the question, the answer, the result
(and the visitor's 👍/👎), the model, attempts, timings, tokens, cost, prompt version, the error if any, the Q&A answers that
matched, and every passage the model was given, with its similarity score. This is how you answer "why did the bot say that?".

## Costs

Costs come from prices you set, because providers change them:

```
LLM_PRICES=gpt-4.1-mini=0.40/1.60, claude-haiku-4-5=1/5    # USD per million input/output tokens, by model id
EMBEDDING_PRICE_PER_MTOK=0.02                               # USD per million embedded tokens
USD_INR_RATE=88.5                                           # optional: also show rupees
```

Check your provider's current price list. Tokens are the provider's own counts when it reports them (OpenAI-compatible
servers with `stream_options`, Anthropic); otherwise they're estimated (about 4 characters per token) and marked ≈. A model
without a price shows "no price". Mock models cost nothing.

## Changing the embedding model

Vectors from different embedding models can't be compared, so every passage records the model that made it and search only
uses the current model's passages. After changing `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` (and `EMBEDDING_DIM`, which needs
a fresh column), open **Operations** and press **Re-index** (the customer app's ingestion worker does the work): websites are read again, files and pasted text are
re-embedded from the content kept when they were added, and Q&A answers are re-embedded. Sources added before content was
kept are listed so their owners can re-add them.
