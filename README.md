# Contract Reader

Upload a contract (PDF or DOCX), ask questions by typing or speaking, and get answers backed by quotes that code has found in the document before they are shown. Click a quote to open the document at that passage, highlighted. Compare two versions and see what changed, ranked by how much it matters.

Two outputs are treated as unacceptable, and most of the design exists to prevent them:

1. **An invented quote presented as real.** A quote is shown as verified only if code finds it word for word in the document.
2. **"It's not in the contract" after reading only part of it.** Absence is only claimed after every readable page was read.

Built to `Contract Analysis App — PRD.md`: all of Part A, all of Part B, and Part C option 2 (agentic document research).

<!--
Add these two lines once they exist, then delete this comment:

**Live app:** https://…
**Demo video:** https://…
-->

## Screenshots

**Answers with verified quotes, and an honest "not found".** Each quote is the document's own text with its page. The last answer was given only after all pages were read, and says so.

![Chat with verified quotes and a not-found answer](docs/screenshots/chat.jpg)

**Click a quote to see it in place.** The viewer opens beside the chat at the passage, highlighted line by line.

![A verified quote highlighted in the PDF viewer](docs/screenshots/highlight.jpg)

**Compare two versions.** A plain-language summary, then every change ranked by significance, with a word-level diff inside the clause.

![Version comparison with ranked changes and a word-level diff](docs/screenshots/compare.jpg)

**Upload states.** A file that isn't a PDF or Word document is refused with a reason, and a scanned PDF is flagged instead of being marked ready with no text behind it.

![Library showing a rejected file and a scanned PDF](docs/screenshots/upload.jpg)

## What it does

**Upload and processing (Part A)**
- PDF and DOCX, checked by extension, file signature and size, in the browser and again on the server.
- Processing runs in the background with page-by-page progress that survives a refresh.
- Scanned PDFs are detected and refused with a clear message. Partly scanned PDFs are accepted, and every answer names the pages that had no readable text. Password-protected and damaged files each get their own message.
- Library with status, retry, and delete. Delete lists the chats and comparisons that will go with the document.

**Chat (Part A)**
- Answers stream as they are written. Stop or Esc ends generation; the partial answer is kept and labelled Stopped, including after a reload or a closed tab.
- Every quote shows "Checking quote…" until it is verified. Verified quotes are shown in the document's own words with a page number. Unverified quotes are struck through with the reason and can't be clicked.
- An answer with no verified quote gets a banner: treat it as unsupported.
- Under each answer: how much of the document it is based on, for example "Read 2 of 150 pages (targeted search)".
- Voice input: record a question and it is transcribed into the question box.

**Highlighting, several documents, comparison (Part B)**
- Clicking a quote opens the PDF or Word document at the passage. Multi-line and cross-page quotes are highlighted line by line, redrawn on zoom (50–200%) and resize. When the same words appear in several places there is an occurrence switcher, opening first at the place the model was given.
- Tick two to five documents and ask one question across them. Each quote is labelled with its document and verified against that document only; a quote attributed to the wrong document is marked "Not in A (appears in B)". Coverage is reported per document.
- Tick two versions and compare. Clauses are aligned (a renumbered clause is matched, not reported as deleted and added), each change gets a significance, and the list can be filtered and sorted.

**Research mode (Part C, option 2)**
- The model reads the contract step by step with five tools (outline, search, read a section, read pages, scan everything), and each step is shown live above the answer.

## How quote verification works

The model is asked to quote like this: `<cite doc="D1">exact words</cite>`.

1. **Held back.** The stream parser never sends text between those tags to the browser. A quote can only arrive as a verified, or explicitly unverified, citation.
2. **Normalised on both sides with one function.** Unicode forms, curly and straight quote marks, dashes, hyphens, whitespace and case are removed, keeping a map from every remaining character back to the original text. This absorbs what PDF extraction and a model legitimately get wrong: line breaks, hyphenated line ends, "pre-existing" versus "preexisting".
3. **Found exactly.** The normalised quote must be a substring of the normalised document. There is no fuzzy matching: one changed, added or missing word fails, and so does a reformatted number ("100,000" is not "100000"). An ellipsis splits a quote into parts that must appear in order, close together.
4. **Second attempt without running headers and footers**, so a quote that crosses a page break still verifies.
5. **Too short proves nothing.** Under 25 normalised characters is "too short to verify".
6. **Shown in the document's words.** The user sees the text at the matched location, never the model's copy. Page numbers come only from the match; any the model writes are stripped.

**Where it fails**
- **Extraction order.** Two-column layouts, tables and footnotes can come out of the PDF in an order that splits a sentence. A genuine quote is then rejected. This fails safe: it is shown as unverified, never as verified.
- **A real quote that doesn't support the claim** still verifies. String matching can't check meaning. The quote is one click from its context for that reason.
- **Repeated text** (boilerplate) can open at the wrong occurrence; the switcher covers this.

## Large documents

The model never sees a 150-page contract at once. Text is split on clause headings into chunks of about 1,000 tokens and indexed with Postgres full-text search, weighted by how rare each word is in that document (otherwise every chunk full of "Borrower" outranks the one that mentions "immunity").

- **Targeted questions** search the whole index and send the best chunks that fit.
- **"Every…", "any…", "is there…" questions** read everything: every chunk goes to the model in batches, each batch returns quotes or nothing, the quotes are verified, and one final call writes the answer from the verified passages.
- **Rules enforced in code, not left to the prompt:**
  - A "not found" from a partial read is never shown. The model states its status first; a "not found" is intercepted and replaced by a full read.
  - If a batch failed or pages had no text, absence is not claimed and the unread pages are listed.
  - If the model points at a passage but misquotes it, that is treated as a lead, not as nothing: it is asked again for exact words, then the document's own closest sentences are passed on. It never becomes "not found".

## Part C: why option 2

- **It strengthens Part A instead of sitting beside it.** The research tools run on the same chunk index and the same verifier as ordinary answers.
- **Its failures are visible and recoverable.** A bad tool call becomes a message the model can correct, and a cap ends any loop. Tracked-change redlining (option 1) fails silently: one misplaced element and Word repairs or refuses the file.
- **It can be tested with any contract.** Redlining quality depends on how each .docx was authored.
- **Trade-off accepted:** redlining would have been the more striking demo.

How far it got: complete. It is a hand-written loop over the chat API rather than an agent framework, so the limits are explicit: at most 8 rounds and 4 calls per round, a token budget, "already returned above" for a repeated call, tools switched off after three invalid calls in a row, and one final call without tools that answers from what was read. Unknown tools, unparseable arguments, documents not in the chat and sections that don't exist all come back to the model as errors listing the valid options. If the provider refuses tool calling, the app falls back to a targeted answer and says so. A "not found" from research still triggers a full read.

## Run it locally

Requirements: Node 24 and Docker.

```bash
npm install
docker compose up -d          # Postgres on localhost:5433
cp .env.example .env          # then add your LLM_API_KEY
npm run dev                   # http://localhost:3000
```

Database migrations run when the server starts. Background jobs run in the same process, so there is nothing else to start. For production: `npm run build` then `npm start`, with `DATABASE_URL` pointing at a Postgres database.

## Model provider and its limits

Any OpenAI-compatible API works (`LLM_BASE_URL`, `LLM_MODEL`). It is set up for Groq: `openai/gpt-oss-120b` for answers and `openai/gpt-oss-20b` for full-read batches.

Groq's free tier allows 8,000 tokens per minute per model and refuses any single request larger than that. With `LLM_TPM=8000` the app sizes every request to fit, paces requests, and waits out rate-limit responses. The effect:

- Targeted answers take 1–3 seconds and are built from about 4 chunks. The coverage line reports exactly what was sent.
- **A full read of a 150-page contract takes about 15–20 minutes** on the free tier. The progress line shows the pages being read.
- Research mode is off by default at this limit, because each round re-sends the conversation. The toggle is in the question box.

On a paid tier, set `LLM_TPM` to the account's limit (or `0` for none) and everything sizes back up.

**Voice.** With `DEEPGRAM_API_KEY` set, a microphone button appears. Audio is sent to this app's server and from there to Deepgram, so the key never reaches the browser. The transcript goes into the question box rather than being sent, because a misheard number changes the question.

## What's finished and what isn't

**Finished and checked end to end** with the real model on generated contracts from 3 to 150 pages: upload and each failure message; streaming, Stop and saved partial answers; verified and unverified quotes; coverage lines; the automatic full read before "not found"; highlighting in PDF and Word, including a quote on page 140 of 150 opened in about a second; comparison ranking a raised liability cap High and a reworded clause Low; research mode with live steps.

**Not finished, or limited**
- **Not deployed yet.**
- **Speed on the free model tier**, as above. The PRD's target of a 150-page full read in under a minute needs a higher rate limit.
- **Word auto-numbering.** Clause numbers generated by Word (1.1, 1.2…) are not in the extracted text, so they don't appear in the viewer and a question like "what does clause 14.2 say" won't resolve in a .docx. Clauses are still found and quoted.
- **Tested on generated contracts, not yet on a wide set of real ones.** Unusual layouts are the main risk; they fail safe, as unverified quotes.
- **Asking across several documents** was exercised with a stand-in model, not yet with the live one.
- **Voice** transcription was checked with recorded speech through the server, not yet with a live microphone.
- **Search is by keyword.** A question worded very differently from the contract can miss in a targeted search; it then falls through to a full read rather than a wrong "not found".
- **Out of scope by design:** OCR, accounts, phone layout, right-to-left text, editing documents.

**Next:** rebuild Word numbering before conversion; OCR for scanned pages; check that a quote actually supports the claim it sits under; semantic search alongside keyword search; export an answer with its quotes.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://contracts:contracts@localhost:5433/contracts` | matches `docker-compose.yml` |
| `LLM_API_KEY`, `LLM_MODEL` | none | required to answer questions |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` | any OpenAI-compatible API; `.env.example` sets Groq |
| `LLM_SCAN_MODEL` | same as `LLM_MODEL` | model for full-read batches |
| `LLM_REASONING_EFFORT` | unset | `low`, `medium` or `high`, for reasoning models |
| `LLM_TPM` | `0` (no limit) | the account's tokens-per-minute limit |
| `DEEPGRAM_API_KEY` | unset | enables voice input |
| `MAX_UPLOAD_MB` | `25` | |
| `MAX_DOCUMENTS` | `50` | the URL is public with no login, so storage is capped |
| `AGENT_MAX_ROUNDS` | `8` | research rounds per question |
| `SCAN_CONCURRENCY` | `4` | parallel batches in a full read |
| `RATE_LIMIT_UPLOADS_PER_HOUR`, `RATE_LIMIT_QUESTIONS_PER_HOUR` | `30`, `120` | per IP address |

Secrets live only in `.env`, which is git-ignored. `.env.example` is the template and holds no keys.

## Where things are

| Path | What it holds |
| --- | --- |
| `lib/verify/` | the quote verifier and the stream parser that holds quotes back |
| `lib/text/` | normalisation, clause and chunk splitting, header and footer detection |
| `lib/ingest/` | file type checks, PDF and DOCX extraction, the processing job |
| `lib/chat/` | question routing, targeted answers, full reads, coverage, the research loop and its tools |
| `lib/compare/` | clause alignment, the rule-based significance floor, summaries |
| `lib/llm/` | the model client and its rate limiter |
| `lib/jobs/` | the background job worker |
| `lib/voice/` | speech-to-text for voice questions |
| `lib/db/`, `lib/documents/` | database schema and document loading |
| `app/api/` | HTTP routes: documents, chats (SSE), comparisons, transcription |
| `components/` | library, chat, document viewer, comparison screen |
| `drizzle/` | database migrations |

One Next.js process serves the interface and the API and runs the background jobs, with Postgres holding all state: one thing to deploy and one thing to debug.
