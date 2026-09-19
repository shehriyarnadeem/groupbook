# Verified Extraction Pipeline

**Turning unstructured text into structured records you can defend.**

A reference architecture for LLM extraction in domains where a wrong value is unacceptable. Two rules drive it:

**Probabilistic components propose. Deterministic components decide.** A model may read text and offer an opinion; a model never writes to the system of record. Everything past extraction is plain TypeScript that returns the same answer twice.

**The system is allowed to say it doesn't know.** When two readings are equally valid, it escalates to a human with the source text and a specific question, rather than guessing. Roughly a third of inputs escalate here — that's the design working, not failing.

Built eval-first: every stage is graded against hand-labeled ground truth before any complexity is added to it, so improvements are measured rather than assumed.

See `PROJECT.md` for the full write-up and `DECISIONS.md` for why each rule exists.

---

## The proving ground

The reference implementation processes WhatsApp booking-group exports into a financial ledger — chosen deliberately as a worst case: no schema, code-switched English and Urdu, typos, voice-note placeholders, and facts fragmented across multiple messages.

The domain is replaceable. The structure isn't. Any *unstructured input → structured records → system of record* workflow fits the same pattern.

## Setup

```bash
npm install zod
```

`.env` at the repo root:
```
GROQ_API_KEY=gsk_...
GROQ_MODEL=openai/gpt-oss-20b
```

Node 20.6+ required. Everything runs with `--experimental-strip-types`, no build step, no bundler.

## Pipeline

```
chat.txt → parse → triage (LLM) → extract (LLM) → resolve (code) → [gate] → [ledger]
                      ↓               ↓                ↓
                grade-triage    grade-extract    resolve.test
```

Stages in brackets aren't built yet.

## Files

### Pipeline stages

| File | What it does |
|---|---|
| `src/parse.ts` | Export → logical messages. Joins continuation lines, merges media+caption pairs, drops noise categories |
| `src/triage.ts` | One LLM call per message → `relevant: true/false`. Resumable, retries on 429 |
| `src/triage-baseline.ts` | Always says `true`. The floor a real classifier must beat (100% recall / 53% precision) |
| `src/extract.ts` | One LLM call per relevant message → array of booking events. Resumable |
| `src/resolve-dates.ts` | Raw phrase + message date → real calendar date. No LLM, pure arithmetic |
| `src/resolve.ts` | Groups events into bookings, or escalates when genuinely ambiguous. No LLM |
| `src/run-resolve.ts` | Entry point that feeds extract output into resolve and prints verdicts |

### Graders and tests

| File | What it does |
|---|---|
| `src/grade-triage.ts` | Predictions vs gold → confusion matrix, recall, precision, F1, plus the specific misses |
| `src/grade-extract.ts` | Predictions vs gold → per-field accuracy, event-count mismatches, every field-level miss |
| `src/resolve-dates.test.ts` | 12 tests, real phrases from the chat |
| `src/resolve.test.ts` | 8 tests, including order-independence |

### Data

| Path | What it is |
|---|---|
| `data/chat.txt` | The real WhatsApp export. Do not clean this up — the mess is the problem being solved |
| `data/gold-triage.json` | 66 hand-labeled messages, 35 relevant. The answer key for triage |
| `data/gold-extract.json` | 35 hand-labeled messages with expected events. The answer key for extract |
| `runs/` | Every prediction file, versioned. Never overwrite an old one — they're how you compare prompt versions |
| `src/make-gold-template.ts` | One-off: dumps parsed messages into a labeling template |

## Running it

```bash
# see what's actually in the export
node --experimental-strip-types src/parse.ts

# triage: generate predictions, then grade them
node --experimental-strip-types --env-file=.env src/triage.ts runs/predictions-model-v3.json
node --experimental-strip-types src/grade-triage.ts runs/predictions-model-v3.json

# the floor to compare against
node --experimental-strip-types src/triage-baseline.ts
node --experimental-strip-types src/grade-triage.ts runs/predictions-baseline.json

# extract: generate, then grade
node --experimental-strip-types --env-file=.env src/extract.ts runs/extract-predictions-v7.json
node --experimental-strip-types src/grade-extract.ts runs/extract-predictions-v7.json

# resolve: no API key needed
node --experimental-strip-types --test src/resolve-dates.test.ts src/resolve.test.ts
node --experimental-strip-types src/run-resolve.ts runs/extract-predictions-v6.json
```

**Always write to a new version file.** Grading an old predictions file against a changed gold set produces confusing garbage, and you lose the ability to compare prompt versions.

## Current scores

| Stage | Score |
|---|---|
| triage v2 | 97.1% recall / 82.9% precision / 89.5% F1 |
| extract v6 | 242/245 fields (98.8%), 0 event-count mismatches |
| resolve-dates | 12/12 tests |
| resolve | 8/8 tests |

Caveat worth remembering: extract's gold set has been tuned against over six rounds, so 98.8% is optimistic. A held-out export would give an honest number.

## Working rules

- **No complexity gets added until a measurement proves the simpler version fails.**
- Every prompt change gets regraded against *everything*, not just the case it targeted. A fix that silently deletes an unrelated rule has happened twice.
- `temperature: 0` everywhere. Non-negotiable — you can't tell a prompt improvement from a dice roll otherwise.
- Ambiguous is a valid output. A human settles it in seconds; a confident wrong number in a ledger is unrecoverable.

See `DECISIONS.md` for why each rule exists, with the concrete case that forced it.