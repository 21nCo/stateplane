# Interactive aggregations (STA-58)

`PostgresAggregations` (`packages/postgres/src/aggregations.ts`) answers bounded, typed aggregations over one collection's declared index fields in one statement snapshot, on analytical capacity apart from interactive authoritative reads. It is the second of five slices of STA-15, after the [analysis job storage](analysis-jobs.md) (STA-57). The application boundary exposes it as `StateplaneServices.analysis.aggregate`; no HTTP, CLI or MCP surface reaches it yet (STA-61). Long or complete analyses that need a pinned watermark are STA-59's jobs, not this.

## Spec

```json
{
  "where": [{ "field": "team", "kind": "string", "operator": "in", "value": ["red", "blue"] }],
  "groupBy": [{ "field": "team" }, { "field": "at", "bucket": { "unit": "day", "timeZone": "America/New_York" } }],
  "metrics": [{ "op": "count" }, { "op": "sum", "field": "score" }, { "op": "avg", "field": "score" }],
  "maxGroups": 100
}
```

- `where` is the exact query's scalar predicates, ANDed: the same shapes, validation and compiler (`predicateFilter`) as `records.query` and `records.count`, each over a ready filterable index of the predicate's kind. There is no OR, no join, no raw SQL and no user code: field names and values are bound parameters, operators and units are allowlisted.
- `groupBy` holds up to 3 dimensions. A string, number or boolean index is grouped by value; a date-time index only by a time bucket (`hour`, `day`, `week`, `month`, `quarter` or `year`) in an IANA time zone, and only it is bucketed.
- `metrics` holds 1 to 16 of `count` (records, no field), `sum` and `avg` (number indexes), and `min` and `max` (number, string and date-time indexes).
- Every grouped or measured field must be a ready declared index (filterable or sortable); an undeclared, unindexed or pending field is `SCHEMA_CONFLICT`, and an operator a field's kind does not accept, or any malformed spec, is `INVALID_ARGUMENT`. The caller needs `records:read` on the collection, which is checked before the spec is validated.

## Semantics

| Aspect | Rule |
| --- | --- |
| Records | The collection's live records (deleted ones never count) matching every predicate |
| Null and missing | Kept apart: a group key is `{ kind: 'value', value }`, `{ kind: 'null' }` (the field holds JSON null) or `{ kind: 'missing' }` (the record lacks it). Groups order by value ascending (strings by UTF-8 bytes, numbers numerically, false before true, buckets by start), then null, then missing. A field metric reports `values`, `nulls` and `missing` counts and is computed over the values only |
| Count | Exact |
| Sum | Exact: PostgreSQL `numeric` over each stored value (the decimal JavaScript writes for it), as a plain decimal string without trailing zeros; `"0"` without values. So 0.1 + 0.2 is `"0.3"` |
| Average | Derived: the exact sum divided by the count of values, rounded half away from zero to 20 significant digits, as a plain decimal string; null without values. The metric says `semantics: 'derived'` and its precision |
| Minimum, maximum | Exact, in the field's own type: numbers as JSON numbers, strings by UTF-8 byte order, date-times by instant (fraction compared as a decimal, a leap second after 23:59:59) as the stored canonical instant |
| Time buckets | Derived, by PostgreSQL's time zone database (`date_trunc` in the zone). A bucket's key is its start instant (`value`, UTC) and its local start with its UTC offset (`local`). Day, week (ISO, from Monday), month, quarter and year buckets start at local midnight, so a DST day is 23 or 25 hours long. An hour bucket is a local wall-clock hour at its members' own UTC offset, so the two 01:00 hours of a fall-back night stay apart; where a shift is not a whole hour (Lord Howe's 30 minutes), an hour bucket's start can precede the first instant the zone's clock shows in it. A stored fraction past microseconds is cut, never rounded into the next second, and a leap second (23:59:60) falls in the minute it ends |

The result reports `source` (space, collection, `records: 'live'`, the predicates, and the policy version and placement generation it was admitted under), `collection` (the schema version read and each used field's declared kind and accepted version), `snapshot` (`scope: 'statement'` and `takenAt`, the statement's start), each dimension's and metric's `semantics`, every group, and `complete: true`.

## One statement snapshot

The groups, metrics, their sizes and the cap checks are one SQL statement, so every number in a result comes from one snapshot, whatever commits meanwhile. It runs in one `READ COMMITTED` transaction that first share-locks the space at the admitted policy version and placement generation, the collection and a key's grant (as `AuthorityTransaction.checkScope` does for every reader), so a schema revision, lifecycle, policy or placement change or grant change cannot commit between the declarations read and the statement; record writers take the same share locks and are not blocked. The transaction ends with the same credential recheck as `records.count`. A cap or limit failure rolls everything back: there is no partial result.

## Budgets

| Budget | Initial value | On excess |
| --- | --- | --- |
| Groups | `maxGroups`, 1 to 1,000, 100 by default | `AggregationLimitError` `groups`, code `RATE_LIMITED`, not retryable |
| Result bytes | 262,144 bytes of group keys and metric values as text | `bytes`, `RATE_LIMITED`, not retryable |
| Statement time | `statement_timeout` 5,000 ms (a service option, 1 to 15,000 ms) | `time`, `RATE_LIMITED`, not retryable: the statement is cancelled |
| Analytical slots | Derived from the cell's origin connection limit (below) | `slots`, `BACKPRESSURE`, retryable, at once (nothing waits) |

`AggregationLimitError` extends `AuthorityError`, so transports map its stable code as for any read; its `limit` names the budget. The statement also runs without parallel workers (`max_parallel_workers_per_gather = 0`), so one slot is one database backend.

## Analytical capacity

An aggregation never uses capacity the interactive reads rely on:

- Each cell has `analyticalSlots(originConnectionLimit)` slots: one fifth of the cell's configured Hyperdrive origin connections (5 to 20 in the topology schema), so 1 at today's 5 and 4 at 20, and a space may use half of them, at least 1. The jobs Worker holds up to half of a cell's origin connections and the API and MCP Workers the rest ([durable outbox](durable-outbox.md)), so at 5 the interactive reads keep at least 2 of their 3 under any analytical load.
- In a process, at most the cell's slot count of aggregations run at once; another is refused before it takes a connection. Each cell's `AggregationCell` names the pool aggregations use; give it a pool of its own, sized to the cell's slots, to keep them off the interactive pool (`ServiceCell.analytics` in `postgresServices`; without it they use the cell pool within the default limit's single slot).
- In the database, an aggregation holds a free (or lapsed) slot of the cell and one of the space in `analysis_cell_slots` and `analysis_space_slots` by row lock (`FOR UPDATE SKIP LOCKED`) for its transaction, after its scope locks (a purge locks its space before its slots). So aggregations across processes and isolates stay within the cell's and the space's budgets, and a slot an analysis job holds is not free. When none is free and fewer slot rows exist than the limit allows, the missing ones are added up to the limit in a short transaction of their own and the aggregation retries once; rows past a lowered limit are ignored.

## Evidence

`test/integration/analysis-aggregations.test.js` (in `pnpm test:postgres`) checks every result against an independent reference oracle written in plain JavaScript from the data the tests wrote: decimal sums and averages with `BigInt` long division, buckets with `Intl` in the requested zones, its own null and missing rules and ordering. The generic fixture mixes nulls and missing fields, decimals whose float sum is inexact, magnitudes from 5e-324 to 1e21, instants around DST changes in New York, Berlin, Lord Howe and Kolkata, a leap second and fractions past microseconds, and replaced, patched and deleted records. A single writer replaces, creates and deletes records while aggregations run, and each result must equal the oracle at one committed state. The suite also covers the spec allowlist and refusals, authorization, the group, byte and time caps with typed errors, the in-process, cell and space slots across two service instances, and interactive reads under saturating analytical load.

Measured locally on PostgreSQL 17 (pgvector image), warm cache: a two-field grouped aggregation over 60,000 records took a median 68 ms serially and 65 ms with two parallel workers, so the analytical budget gives up nothing measurable by forgoing them. With two service instances each driving six concurrent aggregation loops over those records at an origin limit of 5 for 2.5 s, at most one aggregation statement ran at a time (17 and 18 answered, the rest refused with `slots`), while concurrent interactive `records.count` and `records.get` pairs took a median 11.2 and 17.2 ms and at most 57.8 and 145.5 ms in two runs. These are local observations, not Railway or Hyperdrive capacity claims; STA-60 measures the target and records the limits.
