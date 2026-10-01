# AI in production

What happens behind every answer, so the assistant keeps working when a provider has a bad day, stays affordable at
scale, and can be measured. Settings are in [setup](setup.md#4-configuration-reference).

## Reliability

- **Time limits** on every answer: 20 s to the first word, 90 s in total, so a stuck provider can't leave a customer
  waiting.
- **Retries with backoff** (2 by default) for rate limits, overloads, server errors and dropped connections, but only while
  nothing has been shown to the customer, so answers are never repeated or mixed.
- **Backup model** (`LLM_FALLBACK_PROVIDER` / `LLM_FALLBACK_MODEL`): when the main model keeps failing, or its key stops
  working, another provider answers.
- **History by size**: only the newest 6,000 characters of the conversation are sent.
- **Ingestion queue** in Postgres: jobs survive restarts, run safely on several servers, and retry temporary failures
  (3 attempts). Permanent problems, like a 404 page or an empty file, fail at once with a clear message.

## Search quality

- **Hybrid search**: meaning-based search plus keyword search, merged by rank. Product codes (AM-B500), names, prices and
  Hindi words match exactly, and common Hinglish words also search their English equivalents ("atta ka rate" finds
  "price").
- A passage found only by keywords must share half of the question's meaningful words, so loose matches don't pull
  unrelated text into answers.
- Near-duplicates (repeated website footers) are dropped.
- Optional, off until measured: a **reranker** (Cohere or Jina API) and **follow-up rewriting** by a small model.
- Changing the embedding model is safe: every passage records its model, and the admin app re-indexes everything with
  one button.

| Kirana test set (mock models) | Before | After |
| --- | ---: | ---: |
| Right passage found (hit@k) | 50% | 89% |
| Right passage ranked first | 43% | 75% |
| Hinglish questions found | 0% | 100% |
| Correct "I don't know" for off-topic | 100% | 100% |

## Reading documents by their structure

- Sources become headings, paragraphs, lists and tables first. Passages never cross a section, and each remembers its
  heading path and PDF page, so citations say "Store policies › Returns › Electronics (page 4)".
- **Table and spreadsheet rows keep their column names** ("Code: AT-10 · MRP: 520 · Our price: 480").
- PDF running headers and footers are removed, and lines broken mid-sentence are joined.
- **Small to big**: small passages are searched (precise matches), and the model is given the whole section around them
  (complete rules, not half a policy), merged and within a budget per answer (`CHUNK_TOKENS`, `CONTEXT_TOKENS`,
  `CONTEXT_MAX_TOKENS`).
- **Incremental refresh**: every passage has a fingerprint, so re-reading a website re-embeds only what changed, and an
  unchanged page doesn't invalidate cached answers. Websites are re-read every `SOURCE_RESYNC_DAYS` (7).

| Store documents test set (mock models) | Flat chunks | Structured |
| --- | ---: | ---: |
| Whole fact reached the model | 44% | 100% |
| Top passage is only the right row or section | 0% | 100% |
| Right passage found (hit@k) | 100% | 100% |
| Tokens per answer | 588 | 676 |

`CHUNKER=flat` switches back to the old fixed-size passages for comparison.

## Cost controls

- **Answer cache**: a visitor's first question asked word for word before gets the stored answer, with no search and no AI
  call. It's invalidated the moment sources, Q&A answers, instructions, the prompt or the model change. Customers still
  use a credit; your AI cost for that answer is zero.
- **Small-model routing** (`LLM_SMALL_PROVIDER` / `LLM_SMALL_MODEL`): small talk, and questions your own Q&A answers
  already cover closely, go to a cheaper model.
- **Cost tracking**: every answer records its tokens and cost (from `LLM_PRICES`), shown per account and per model in the
  [admin app](admin.md), in USD and rupees.

## Hard-to-read sources

- **Scanned PDFs and photos** (`OCR_PROVIDER` + `OCR_MODEL`): PDFs with almost no text layer are read by a vision model,
  and owners can upload photos of price lists and menus.
- **JavaScript-built websites** (`PRERENDER_URL`): pages that are an empty app shell are fetched through a rendering
  service.

## Quality evaluation

`pnpm eval` asks a set of real customer questions through the actual answer pipeline and scores whether the right passage
was found, whether the answer has the right fact, whether off-topic questions get "I don't know", and whether the reply
uses the customer's script. It also reports speed and cost per answer, and `--check` fails when a score drops more than
5 points below the saved baseline. See [testing](testing.md#answer-quality-evaluation).
