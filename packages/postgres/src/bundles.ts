import type { VerifiedCredential } from '@stateplane/contracts';
import { assembleBundle, bundleBounds, codePoints, exactQuestion } from '@stateplane/retrieval';
import type { BundleBudget, BundleExcerpt } from '@stateplane/retrieval';
import { boundedText, fields, invalid } from './sources.js';
import { PostgresRetrievalSearch, searchBounds } from './search.js';
import type { SearchResult } from './search.js';

/**
 * A bounded context bundle: cited excerpts of what the caller may read now,
 * for one explicit task or query, framed as untrusted data and within the
 * requested budget. It is never a complete answer and holds no count, status
 * or completeness of its own.
 */
export interface ContextBundle {
  spaceId: string; task: string | null; query: string;
  /** The requested budget, and what the context uses of it (`tokensAtMost` is an upper bound, not an estimate). */
  budget: BundleBudget; usage: { bytes: number; tokensAtMost: number };
  /** The text for a model's context: a frame marking it untrusted, and each excerpt escaped and numbered. */
  context: string;
  /** Each excerpt's citation, numbered as in `context`. */
  excerpts: BundleExcerpt[];
  /** Whether an excerpt was cut short or a cited range left out for the budget. */
  truncated: boolean;
  trust: 'untrusted'; complete: false;
  /**
   * How the excerpts were found: the search's mode (`hybrid` or `lexical`) and
   * projection state (`current`, `pending` or `degraded`). No match count or
   * exhaustion signal is carried: whether more exists is for exact reads.
   */
  coverage: { mode: SearchResult['mode']; state: SearchResult['state'] };
}

const requestFields = Object.freeze(['task', 'query', 'budget', 'collections', 'kinds', 'limit']);
const budgetFields = Object.freeze(['bytes', 'tokens']);

interface Request { task: string | null; query: string | null; budget: BundleBudget; search: Record<string, unknown> }

/** One instruction text: nonblank, within what search accepts as a query. */
function text(value: unknown, name: string): string {
  if (!boundedText(value, searchBounds.queryBytes) || codePoints(value).length > searchBounds.queryCodePoints || !value.trim())
    invalid(`${name} must be nonblank text of at most 1,000 code points and 4,000 bytes`);
  return value;
}

function parse(request: unknown): Request {
  const input = fields(request, requestFields, ['budget']);
  const task = input.task === undefined ? null : text(input.task, 'task');
  const query = input.query === undefined ? null : text(input.query, 'query');
  if (task === null && query === null) invalid('A bundle needs a task or a query');
  const limits = fields(input.budget, budgetFields, []);
  const limit = (value: unknown) => {
    if (value === undefined) return null;
    if (!Number.isSafeInteger(value) || (value as number) < bundleBounds.minBudget || (value as number) > bundleBounds.maxBudget)
      invalid(`A budget limit must be an integer from ${bundleBounds.minBudget} to ${bundleBounds.maxBudget}`);
    return value as number;
  };
  const budget = { bytes: limit(limits.bytes), tokens: limit(limits.tokens) };
  if (budget.bytes === null && budget.tokens === null) invalid('A bundle needs a byte or token budget');
  // Everything else is the search's to validate, exactly as a search request.
  const search: Record<string, unknown> = { query: query ?? task };
  for (const name of ['collections', 'kinds', 'limit']) if (input[name] !== undefined) search[name] = input[name];
  return { task, query, budget, search };
}

/**
 * Bounded context bundles over hybrid search. A bundle is assembled only
 * from hits `PostgresRetrievalSearch.search` returned, which reread and
 * reauthorized every one at authority in a fresh transaction, so a deleted,
 * revoked, unauthorized or stale hit never reaches a bundle, and the bundle's
 * authorization is the search's, current at its commit. Assembly runs after
 * that commit, reads nothing and calls nothing, so it cannot widen what the
 * search authorized. A request asking a count, status or completeness
 * question is refused before anything is searched or embedded.
 */
export class PostgresContextBundles {
  constructor(private readonly search: PostgresRetrievalSearch) {
    if (!(search instanceof PostgresRetrievalSearch)) throw new RangeError('Invalid search service');
  }

  /**
   * Bundle `spaceId` for `request`: `{ task?, query?, budget: { bytes?, tokens? }, collections?, kinds?, limit? }`.
   * At least one of `task` and `query` (the query is searched, the task when
   * there is no query) and at least one budget limit, from 1,024 to 262,144;
   * `collections`, `kinds` and `limit` are the search's.
   */
  async bundle(actor: VerifiedCredential, spaceId: string, request: unknown): Promise<ContextBundle> {
    const input = parse(request);
    for (const value of [input.task, input.query]) {
      const question = value === null ? null : exactQuestion(value);
      if (question) invalid(`Context bundles do not answer ${question} questions; use exact reads of records, sources and claims`);
    }
    const result = await this.search.search(actor, spaceId, input.search);
    const assembled = assembleBundle(result.results.map(hit => ({ ref: hit.ref, revision: hit.revision,
      extractionVersion: hit.extractionVersion, verifiedAt: hit.freshness.verifiedAt, review: hit.review,
      attributedTo: hit.provenance.attributedTo, citations: hit.citations })), input.budget);
    return { spaceId, task: input.task, query: result.query, budget: input.budget, usage: assembled.usage, context: assembled.context,
      excerpts: assembled.excerpts, truncated: assembled.truncated, trust: 'untrusted', complete: false,
      coverage: { mode: result.mode, state: result.state } };
  }
}
