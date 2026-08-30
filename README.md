# Order/Payment Reconciliation Dashboard

A web app that ingests an order export and a payment-processor export, reconciles
them deterministically, and presents the result as a dashboard with a
plain-language explanation layer on top.

## Live deployment

- App: reconciliation-app-roan.vercel.app
- Repo: https://github.com/neelamkumari31/reconciliation-app
- Test login: test@example.com / test1234 (or sign up fresh — signup is open)

## Stack

- **Framework**: Next.js 14 (App Router) — frontend and backend API routes in a single deployable project.
- **Language**: TypeScript throughout.
- **Auth**: NextAuth (Auth.js), credentials provider, passwords hashed with bcrypt, JWT sessions. Routes under `/dashboard` and `/upload` are protected by middleware; every API route re-checks the session server-side and scopes all DB queries to `userId`.
- **Database**: Postgres (hosted on Neon/Supabase — any Postgres works), accessed through Prisma.
- **Charts**: Recharts.
- **LLM**: Google Gemini (`gemini-2.0-flash`, free tier, no credit card required), called only from `app/api/explain/route.ts`.
- **Hosting**: Vercel (app) + Neon/Supabase (DB).

## Local setup

```bash
npm install
cp .env.example .env       # fill in DATABASE_URL, NEXTAUTH_SECRET, GEMINI_API_KEY
npx prisma db push         # creates tables in your Postgres instance
npm run dev
```

Visit `http://localhost:3000`, sign up, then upload `orders.csv` and `payments.csv`
on the `/upload` screen.

## Architecture

```
app/
  api/
    auth/[...nextauth]/   NextAuth handler
    auth/register/        Sign-up (bcrypt hash + create user)
    upload/                Parses both CSVs, stores rows scoped to the user
    reconcile/              Runs the deterministic engine, persists a run + discrepancies
    runs/latest/             Fetches the most recent run (used by the dashboard)
    explain/                  LLM explanation endpoint (backend-only)
  dashboard/               Server component fetches the latest run; client component
                            renders stats, chart, and the filterable drill-down table
  upload/, login/, register/  Forms with loading + error states
lib/
  reconcile.ts             Pure, deterministic matching/classification logic (no I/O, no LLM)
  llm.ts                   OpenAI call + structured-output validation (zod)
  csv.ts, auth.ts, db.ts, session.ts   Supporting utilities
prisma/schema.prisma       User, Order, Payment, ReconciliationRun, Discrepancy
```

Data flow: CSV upload → rows stored as `Order`/`Payment` rows scoped to the
uploading user → `/api/reconcile` loads that user's rows, runs the pure
`reconcile()` function, and persists the result as a `ReconciliationRun` with
its `Discrepancy` children → the dashboard reads the latest run → a user can
click "Explain" on any row, which calls the LLM **only for that already-decided
discrepancy** and caches the explanation.

## Reconciliation logic

Matching key: `order_id` / `order_reference`, normalized with `.trim().toUpperCase()`
before comparison. The raw payments export contains values like `' ord-1801 '`
and `'ord-1802'` — naive string equality would silently treat these as
non-matches, so normalization happens before any comparison, not just at display time.

Discrepancy types, in the order the engine evaluates them:

| Type | Trigger | Amount at risk |
|---|---|---|
| `DUPLICATE_ORDER` | Same normalized `order_id` appears more than once in the order export with the same data | Value of the extra copies |
| `ORPHAN_PAYMENT` | A payment's `order_reference` matches no order at all | Full payment amount |
| `MISSING_PAYMENT` | A `completed` order has zero matching payment rows | Full order value |
| `STATUS_MISMATCH` | An order marked `cancelled` has a settled charge against it | Full charged amount |
| `UNSETTLED_PAYMENT` | A matched payment's status is `pending` or `failed` | Order value if `failed`; 0 if `pending` (not yet a loss) |
| `DUPLICATE_CHARGE` | More than one **settled** charge for the same order at the same amount | Sum of the extra charges (the refund owed) |
| `FULL_REFUND` / `PARTIAL_REFUND` | A charge plus refund(s) net to ~0 or to something less than the charge | 0 — these are informational; the money already moved correctly between the parties, this just documents that it happened |
| `CURRENCY_MISMATCH` | Matched order and payment have the same numeric amount but different currency codes | 0 — flagged as a data-quality issue, not a loss, since the numeric values agree |
| `AMOUNT_MISMATCH` | A single settled charge for a single order, amounts differ beyond tolerance | Absolute difference |

**Tolerance**: amounts within **$0.02** of each other are treated as equal
(covers floating-point/rounding noise seen in the sample data, e.g.
`68.65` vs `68.63`). Anything beyond that is a real `AMOUNT_MISMATCH`, split
into `medium` (≤$20 off) and `high` (>$20 off) severity — an arbitrary but
explainable cutline meant to separate "someone should glance at this" from
"this needs attention today."

**Why these rules, not others**: I deliberately did *not* try to fuzzy-match
on customer email or date proximity for orphaned records — with only ~185 rows
and a handful of true orphans, a confident ID-based miss is more trustworthy
than a probabilistic guess, and the brief explicitly asks to avoid inventing
false positives. If this scaled to messier, larger data I'd add an email +
date-proximity fallback match *as a separate, lower-confidence discrepancy
type*, never silently merged into a clean match.

## What I found in the data

Profiling `orders.csv` (185 rows) and `payments.csv` (187 rows) turned up:

1. **One exact duplicate order row** (`ORD-1004`) — same order counted twice if not deduplicated.
2. **Two double charges** (`ORD-1501`, `ORD-1502`) — the same amount charged twice, ~30 minutes apart. This is the clearest "money at risk" finding: real refunds owed to customers.
3. **Inconsistent ID casing/whitespace** in `payments.csv` (`' ord-1801 '`, `'ord-1802'`) — a naive exact-match join would have misclassified these as orphans/missing payments purely due to formatting, not a real business problem.
4. **Three orphan payments** (`ORD-1301`–`ORD-1303`) with no corresponding order at all — money moved that the order system has no record of.
5. **Four orders with no payment at all** (`ORD-1201`–`ORD-1204`), all marked `completed` — revenue booked that was never actually collected.
6. **A full refund and a partial refund** (`ORD-1702`, `ORD-1703`) that need refund-aware netting rather than simple presence-of-payment checks.
7. **Several real amount mismatches** on otherwise clean 1:1 matches (e.g. order net `92.81` vs payment `117.81`) — genuine discrepancies, not rounding.
8. **A currency-field swap** on two orders (`ORD-1601`, `ORD-1602`) where the order and payment currencies are transposed for the same numeric amount — looks like a data-entry error, not a real cross-currency transaction.
9. **Different date formats** between the two exports (`YYYY-MM-DD HH:MM:SS` vs `DD/MM/YYYY HH:MM`) — a parsing hazard, not a business discrepancy, but worth normalizing carefully so records aren't silently misdated.

**Business implication**: the double charges and orphan payments are the most
urgent — they represent money that has moved incorrectly and is currently
sitting unresolved. The missing-payment orders represent booked revenue that
isn't real yet. Together these are exactly the kind of leakage a reconciliation
process is meant to surface before it compounds.

## LLM approach

- **Where it runs**: only inside `app/api/explain/route.ts`, server-side. `GEMINI_API_KEY` is never sent to the client and is not present in any client bundle — the request goes from our server to Google's API directly.
- **What it's given**: the *already-decided* discrepancy record(s) from the database (type, refs, amounts, the deterministic `detail` string) — never the raw CSVs, and it is never asked to decide whether records match.
- **Structured output**: the model is called with Gemini's `responseSchema`/`responseMimeType: "application/json"` constrained-decoding feature, asking for exactly `summary`, `likely_cause`, `recommended_action`, and the response is still independently validated server-side with `zod` before use. If parsing or shape validation fails, the route returns a `502` with a clear message instead of showing garbage or crashing — see `LlmFormatError` in `lib/llm.ts`.
- **Temperature: 0.2.** This is a summarization task over fixed, already-correct data, not creative generation — low temperature keeps explanations consistent across repeated calls for the same discrepancy. I didn't use `0` because in testing it produced slightly clipped, repetitive phrasing; `0.2` kept it natural while staying far from the range where wording would meaningfully vary run to run.
- **Failure handling**: missing API key → `503` before ever calling out; non-2xx response, malformed JSON, or a wrong shape → `502` with a user-facing message; the frontend shows a distinct loading state ("Explaining…") and a dismissable error box per row, and never blocks the rest of the dashboard on an LLM failure.
- **Why Gemini over OpenAI**: functionally interchangeable for this task (the brief explicitly allows "OpenAI or another LLM API") — chosen here for a free tier with no credit card requirement, keeping the whole project's cost at zero.

## What I'd improve with more time

- Email + date-proximity fallback matching for orphaned records, as its own lower-confidence discrepancy type.
- Batch "explain all" for a filtered set, with a queue instead of one call per row.
- CSV schema validation with row-level error reporting (currently a bad file is rejected wholesale).
- Audit history across multiple reconciliation runs instead of only "latest."
- Tests for `lib/reconcile.ts` (it's pure and easy to unit test — I prioritized shipping the full flow over test coverage given the time budget).

## AI tool usage note

This project was built with AI assistance for scaffolding and boilerplate
(Next.js routes, Prisma schema, CSS). The reconciliation rules, tolerances,
and the data findings above came from directly profiling the CSVs and
deciding what counted as a discrepancy — every rule in `lib/reconcile.ts` is
something I can walk through and justify line by line.
