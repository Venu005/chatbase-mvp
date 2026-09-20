# AI providers

The app needs two models: a **chat model** that writes answers, and an **embedding model** that turns your documents and
customers' questions into vectors so the right passages can be found. They are configured separately.

| | mock | openai | anthropic | sarvam |
| --- | --- | --- | --- | --- |
| Chat (`LLM_PROVIDER`) | yes (test only) | yes, any OpenAI-compatible API | yes | yes |
| Embeddings (`EMBEDDING_PROVIDER`) | yes (test only) | yes, any OpenAI-compatible API | no | no |

So Claude and Sarvam are always paired with an OpenAI-compatible embedding model.

> **Status of testing.** Every provider was tested against local fake servers that imitate the documented request and
> response formats, including streaming. None has been run against the live services from this repository, so run
> `pnpm preflight --live` with your keys before you rely on them. It makes one small chat call and one embedding call and
> checks the embedding size.

## Recipes (copy the lines into `.env`)

### A. OpenAI for everything

```bash
LLM_PROVIDER=openai
LLM_MODEL=<a chat model id your OpenAI account can use>
OPENAI_API_KEY=sk-...
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIM=1536
```

The embedding settings reuse `OPENAI_API_KEY`. Use `EMBEDDING_API_KEY` if you want a separate key.

### B. Claude for answers, OpenAI for embeddings

```bash
LLM_PROVIDER=anthropic
LLM_MODEL=<a Claude model id from your Anthropic console>
ANTHROPIC_API_KEY=sk-ant-...
EMBEDDING_PROVIDER=openai
EMBEDDING_API_KEY=sk-...
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIM=1536
```

### C. Sarvam for answers (Indian languages), OpenAI for embeddings

```bash
LLM_PROVIDER=sarvam
SARVAM_API_KEY=...                  # https://dashboard.sarvam.ai
LLM_MODEL=                          # blank = sarvam-105b. Other option in Sarvam's docs: sarvam-105b-conversations
SARVAM_REASONING_EFFORT=none        # no visible "thinking", faster and cheaper
EMBEDDING_PROVIDER=openai
EMBEDDING_API_KEY=sk-...
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIM=1536
```

What we know about Sarvam's chat API (from its documentation when this was written; check
https://docs.sarvam.ai/api-reference/chat/chat-completions for changes):

- Endpoint `POST https://api.sarvam.ai/v1/chat/completions`, key sent in the `api-subscription-key` header, OpenAI-style
  request and streaming (server-sent events with `choices[].delta.content`).
- Chat models: `sarvam-105b` (128K context) and `sarvam-105b-conversations` (32K context), tuned for 22 Indian languages plus
  English. The older Sarvam-M and 30B models are listed as deprecated. Open-source models offered on the platform are stated
  not to be tuned for Indian languages.
- There is **no embeddings API**, hence the pairing with another embedding provider.
- The provider turns reasoning off when `SARVAM_REASONING_EFFORT=none`, strips any `<think>...</think>` text from the reply
  so customers never see it, and merges consecutive same-role messages (a handoff can produce them) because some chat
  endpoints reject histories that do not alternate user/assistant.

### D. Self-hosted, OpenAI-compatible (Ollama example, untested here)

```bash
LLM_PROVIDER=openai
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama               # any non-empty value
LLM_MODEL=<a model you have pulled>
EMBEDDING_PROVIDER=openai
EMBEDDING_BASE_URL=http://localhost:11434/v1
EMBEDDING_API_KEY=ollama
EMBEDDING_MODEL=<an embedding model you have pulled>
EMBEDDING_DIM=<that model's vector size, e.g. 1024>
```

The same shape works for vLLM, LiteLLM and cloud gateways that speak the OpenAI API.

## The vector size is permanent

`EMBEDDING_DIM` becomes the column type of the `chunks` table when you first run `pnpm migrate`. If you later switch to a
model with a different size you need an empty database (or to re-run the migration and re-add every source). `pnpm preflight`
warns when `.env` and the database disagree, and `pnpm preflight --live` warns when the model returns a different size than
`EMBEDDING_DIM`. Models that accept a `dimensions` parameter (for example the text-embedding-3 family) can be shrunk to your
chosen size with `EMBEDDING_SEND_DIMENSIONS=true`.

## Quality tips for Indian languages

- Use a **multilingual** embedding model and test it on real customer questions in Hindi, Hinglish and your regional
  language before trusting it. English-only embedding models retrieve poorly for other scripts.
- Tune `RETRIEVAL_MIN_SCORE`. Too high and the assistant says "I don't know" too often; too low and it gets irrelevant
  passages. With a real model start near `0.25` and adjust while watching the Chats tab.
- The assistant is instructed to answer in the language and script of the question (including Hindi typed in English
  letters). Put the language policy you want into the agent's **Instructions** if you need to be stricter.

## Adding another provider

Implement `LLMProvider` (or `EmbeddingProvider`) from `src/lib/providers/types.ts`, register it in
`src/lib/providers/index.ts`, and add its variables to `.env.example`, `docs/setup.md` and `scripts/preflight.mjs`.
`src/lib/providers/sarvam.ts` is a compact example of a provider with its own auth header and reply clean-up.
