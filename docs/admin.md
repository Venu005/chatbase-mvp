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
| **Accounts** | Every account: plan, credits used this month (the bar turns red above 90 %), agents, conversations, answers, failed answers, 👎, AI cost, last activity. Click one for its agents (sources, passages, Q&A answers, channels, knowledge-gap rate, leads, cost) and its latest AI calls. |
| **Problems** | Answers that failed, were cut off, needed retries, or were written by the backup model, with the error. |
| **Models & ingestion** | Calls, failures, tokens, average time to the first word and cost per model; the ingestion queue (waiting, running, ready, failed, with each failure's error); the embedding model status and **Re-index**. |

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
a fresh column), open **Models & ingestion** and press **Re-index** (the customer app's ingestion worker does the work): websites are read again, files and pasted text are
re-embedded from the content kept when they were added, and Q&A answers are re-embedded. Sources added before content was
kept are listed so their owners can re-add them.
