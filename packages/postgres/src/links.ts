import type pg from 'pg';
import { capabilities } from '@stateplane/contracts';
import type { Capability, VerifiedCredential } from '@stateplane/contracts';
import { AuthorityError, AuthorityTransaction } from './index.js';
import type { AuthorityScope } from './index.js';
import { includes } from './schema.js';
import type { PostgresSpaces } from './spaces.js';
import { boundedText, digest, evidenceEvent, evidenceRefusal, fields, idempotencyKey, invalid, iso, lockKey, reference, rowsRetained,
  serialized, transact, writable } from './sources.js';
import type { Db, DeletionErasure } from './sources.js';

/** One cell's authority pool. */
export interface LinkCell { pool: Pick<pg.Pool, 'connect'> }
export type LinkEndpointKind = 'record' | 'source' | 'claim';
export interface LinkEndpoint { kind: LinkEndpointKind; collectionId: string; id: string }
export type LinkPolicy = 'restrict' | 'detach';
/**
 * A typed link between two endpoints of one space, owned by one endpoint's
 * collection. It carries references only: no endpoint content, credential
 * or principal.
 */
export interface LinkView {
  linkId: string; collectionId: string; type: string; policy: LinkPolicy; from: LinkEndpoint; to: LinkEndpoint;
  revision: number; deleted: boolean; createdAt: string; deletedAt: string | null; replayed: boolean;
}
/** A deleted link and what remains: its row stays, unreadable, until the space is erased, and backups keep earlier copies. */
export interface LinkDeletion extends LinkView { erasure: DeletionErasure }
/** `next` is the `after` value for the following page, or null on the last page. */
export interface LinkPage { links: LinkView[]; next: string | null }

/** Initial bounds; docs/evidence-storage.md records the evidence for each. */
export const linkBounds = Object.freeze({ typeBytes: 256, page: 50 });

const isSafeInteger = Number.isSafeInteger;
// Request field lists are fixed at module load and read by own index, never through an array iterator.
const createFields = Object.freeze(['idempotencyKey', 'type', 'policy', 'from', 'to']);
const endpointFields = Object.freeze(['kind', 'collectionId', 'id']);
const listFields = Object.freeze(['endpoint', 'after', 'limit']);
const listEndpointFields = Object.freeze(['kind', 'id']);
const readCapabilities: readonly Capability[] = Object.freeze(['records:read', 'sources:read', 'claims:read']);

const readOf = (kind: LinkEndpointKind): Capability =>
  kind === 'record' ? 'records:read' : kind === 'source' ? 'sources:read' : 'claims:read';
const writeOf = (kind: LinkEndpointKind): Capability =>
  kind === 'record' ? 'records:write' : kind === 'source' ? 'sources:write' : 'claims:write';
function put<T>(list: T[], value: T): void {
  Object.defineProperty(list, list.length, { value, writable: true, enumerable: true, configurable: true });
}
const at = <T>(list: readonly T[], index: number): T => Object.getOwnPropertyDescriptor(list, index)!.value as T;
const derivedLinkId = (credentialId: string, key: string) => `lnk_${digest(serialized(['link', credentialId, key]))}`;
const sameEndpoint = (a: LinkEndpoint, b: LinkEndpoint) => a.kind === b.kind && a.collectionId === b.collectionId && a.id === b.id;
const linkLiveEndpoint = (error: unknown) => (error as { code?: unknown })?.code === '23503' &&
  (error as { constraint?: unknown }).constraint === 'links_live_endpoint';

function endpointKind(value: unknown): LinkEndpointKind {
  if (value !== 'record' && value !== 'source' && value !== 'claim') invalid('Endpoint kind must be record, source or claim');
  return value;
}
function endpoint(value: unknown): LinkEndpoint {
  const input = fields(value, endpointFields, endpointFields);
  const kind = endpointKind(input.kind);
  if (!reference(input.collectionId) || !reference(input.id)) invalid('Invalid link endpoint');
  return { kind, collectionId: input.collectionId, id: input.id };
}
function linkView(row: Record<string, unknown>, replayed: boolean): LinkView {
  return { linkId: String(row.link_id), collectionId: String(row.collection_id), type: String(row.link_type),
    policy: row.deletion_policy as LinkPolicy,
    from: { kind: row.from_kind as LinkEndpointKind, collectionId: String(row.from_collection_id), id: String(row.from_id) },
    to: { kind: row.to_kind as LinkEndpointKind, collectionId: String(row.to_collection_id), id: String(row.to_id) },
    revision: Number(row.revision), deleted: row.tombstone === true, createdAt: iso(row.created_at)!,
    deletedAt: iso(row.tombstoned_at), replayed };
}
/** A stored link's endpoints, read by own index (`at`), never through an array iterator. */
const endpointsOf = (row: Record<string, unknown>): readonly LinkEndpoint[] => {
  const view = linkView(row, false);
  return [view.from, view.to];
};

/** Every collection any revision of a claim cites. */
const citedOf = (side: 'from' | 'to') => `CASE WHEN l.${side}_kind='claim' THEN ARRAY(SELECT DISTINCT a.source_collection_id
    FROM claim_evidence a WHERE a.space_id=l.space_id AND a.collection_id=l.${side}_collection_id AND a.claim_id=l.${side}_id)
  ELSE '{}'::text[] END AS ${side}_cited`;
const linkSelect = `SELECT l.*,${citedOf('from')},${citedOf('to')} FROM links l`;
/**
 * Whether the caller could read a link's endpoint directly, given the
 * collections where it holds `records:read` ($6), `sources:read` ($7) and
 * `claims:read` ($8): a claim also needs every collection it cites.
 */
const visibleSql = (side: 'from' | 'to') => `((l.${side}_kind='record' AND l.${side}_collection_id=ANY($6::text[]))
  OR (l.${side}_kind='source' AND l.${side}_collection_id=ANY($7::text[]))
  OR (l.${side}_kind='claim' AND l.${side}_collection_id=ANY($8::text[]) AND NOT EXISTS (SELECT 1 FROM claim_evidence a
    WHERE a.space_id=l.space_id AND a.collection_id=l.${side}_collection_id AND a.claim_id=l.${side}_id
      AND NOT (a.source_collection_id=ANY($7::text[])))))`;

/**
 * The caller's grants across the space, read once per transaction, and a
 * fence for every (collection, capability) the call relies on: its grant,
 * lifecycle, policy version and placement are share-locked and checked again
 * before COMMIT and in the final grant statement. A link widens nothing: each
 * endpoint is authorized on its own collection, exactly as if read directly.
 */
class Access {
  private granted: { collections: string[]; capabilities: string[][] } | null = null;
  readonly collections: string[] = [];
  readonly capabilities: string[] = [];
  private readonly fences: AuthorityTransaction[] = [];
  constructor(private readonly db: Db, private readonly scope: AuthorityScope) {}

  private async load(): Promise<{ collections: string[]; capabilities: string[][] }> {
    if (this.granted) return this.granted;
    const rows = (await this.db.query(`SELECT c.collection_id,
        CASE WHEN s.owner_principal_id=$3 THEN $4::text[] ELSE g.capabilities END AS capabilities
      FROM collections c JOIN spaces s ON s.space_id=c.space_id
      LEFT JOIN collection_grants g ON g.space_id=c.space_id AND g.collection_id=c.collection_id AND g.credential_id=$2
      WHERE c.space_id=$1 AND c.lifecycle<>'deleted' AND (s.owner_principal_id=$3 OR (g.capabilities IS NOT NULL
        AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())))`,
    [this.scope.spaceId, this.scope.credentialId, this.scope.principalId, capabilities])).rows;
    const granted = { collections: [] as string[], capabilities: [] as string[][] };
    for (let i = 0; i < rows.length; i++) {
      put(granted.collections, String(rows[i].collection_id));
      put(granted.capabilities, rows[i].capabilities as string[]);
    }
    this.granted = granted;
    return granted;
  }
  async has(collectionId: string, capability: Capability): Promise<boolean> {
    const granted = await this.load();
    for (let i = 0; i < granted.collections.length; i++)
      if (at(granted.collections, i) === collectionId) return includes(at(granted.capabilities, i), capability);
    return false;
  }
  /** Every live collection where the caller holds the capability. */
  async holding(capability: Capability): Promise<string[]> {
    const granted = await this.load();
    const held: string[] = [];
    for (let i = 0; i < granted.collections.length; i++)
      if (includes(at(granted.capabilities, i), capability)) put(held, at(granted.collections, i));
    return held;
  }
  /** Fail with `refusal`, before anything in the collection is read, unless the caller holds the capability; then fence it. */
  async require(collectionId: string, capability: Capability, refusal: 'FORBIDDEN' | 'NOT_FOUND'): Promise<void> {
    if (!await this.has(collectionId, capability)) throw new AuthorityError(refusal);
    for (let i = 0; i < this.collections.length; i++)
      if (at(this.collections, i) === collectionId && at(this.capabilities, i) === capability) return;
    const fence = new AuthorityTransaction(this.db, { ...this.scope, collectionId: collectionId as AuthorityScope['collectionId'],
      capability }, 1);
    put(this.fences, fence);
    put(this.collections, collectionId);
    put(this.capabilities, capability);
    await fence.checkScope();
  }
  /** Admit the owning collection: FORBIDDEN unless the caller may read something in it. */
  async enter(collectionId: string): Promise<void> {
    for (let i = 0; i < readCapabilities.length; i++) {
      const capability = at(readCapabilities, i);
      if (await this.has(collectionId, capability)) return this.require(collectionId, capability, 'FORBIDDEN');
    }
    throw new AuthorityError('FORBIDDEN');
  }
  /**
   * Whether the caller may read this endpoint, as if it read the endpoint
   * itself: its kind's read capability on its collection, and for a claim
   * `sources:read` on every collection any of its revisions cites.
   */
  async visible(endpoint: LinkEndpoint, cited: readonly string[]): Promise<boolean> {
    if (!await this.has(endpoint.collectionId, readOf(endpoint.kind))) return false;
    for (let i = 0; i < cited.length; i++) if (!await this.has(at(cited, i), 'sources:read')) return false;
    return true;
  }
  /** Fence what `visible` relied on; NOT_FOUND when the endpoint is not visible. */
  async see(endpoint: LinkEndpoint, cited: readonly string[]): Promise<void> {
    if (!await this.visible(endpoint, cited)) throw new AuthorityError('NOT_FOUND');
    await this.require(endpoint.collectionId, readOf(endpoint.kind), 'NOT_FOUND');
    for (let i = 0; i < cited.length; i++) await this.require(at(cited, i), 'sources:read', 'NOT_FOUND');
  }
  async recheck(): Promise<void> {
    for (let i = 0; i < this.fences.length; i++) await at(this.fences, i).checkScope();
  }
  close(): void { for (let i = 0; i < this.fences.length; i++) at(this.fences, i).close(); }
}

/**
 * The final authority check, run after the call's last provider await with
 * no other await after it: one statement, against one clock reading, checks
 * the credential and every (collection, capability) the call relied on.
 */
async function assertGrantsCurrent(db: Db, scope: AuthorityScope, ownerPrincipalId: string, access: Access): Promise<void> {
  const row = (await db.query(`WITH t AS (SELECT clock_timestamp() AS now),
    live AS (SELECT g.collection_id,g.capabilities FROM t,space_credentials sc
      JOIN collection_grants g ON g.space_id=sc.space_id AND g.credential_id=sc.credential_id
      JOIN collections c ON c.space_id=g.space_id AND c.collection_id=g.collection_id
      WHERE sc.space_id=$1 AND sc.credential_id=$2 AND sc.owner_principal_id=$3 AND c.lifecycle<>'deleted'
        AND sc.activated_at IS NOT NULL AND sc.confirmed_at IS NOT NULL AND sc.revoked_at IS NULL AND sc.expires_at>t.now
        AND (g.expires_at IS NULL OR g.expires_at>t.now))
    SELECT EXISTS (SELECT 1 FROM t,space_credentials sc WHERE sc.space_id=$1 AND sc.credential_id=$2
        AND sc.owner_principal_id=$3 AND sc.activated_at IS NOT NULL AND sc.confirmed_at IS NOT NULL
        AND sc.revoked_at IS NULL AND sc.expires_at>t.now)
      AND NOT EXISTS (SELECT 1 FROM unnest($4::text[],$5::text[]) AS x(id,capability) WHERE NOT EXISTS (SELECT 1 FROM live
        WHERE live.collection_id=x.id AND x.capability=ANY(live.capabilities))) AS current`,
  [scope.spaceId, scope.credentialId, ownerPrincipalId, access.collections, access.capabilities])).rows[0];
  if (row?.current !== true) throw new AuthorityError('FORBIDDEN');
}

/** Writers of one link, including a create and its retries, serialize on its identity. */
async function lockLink(db: Db, spaceId: string, linkId: string): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey(['stateplane:link', spaceId, linkId])]);
}
/** A live endpoint and, for a claim, the collections its revisions cite; null when missing or deleted. */
async function liveEndpoint(db: Db, spaceId: string, endpoint: LinkEndpoint): Promise<string[] | null> {
  const row = endpoint.kind === 'record'
    ? (await db.query(`SELECT tombstone,'{}'::text[] AS cited FROM records WHERE space_id=$1 AND collection_id=$2
        AND record_id=$3`, [spaceId, endpoint.collectionId, endpoint.id])).rows[0]
    : (await db.query(`SELECT e.tombstone,ARRAY(SELECT DISTINCT a.source_collection_id FROM claim_evidence a
          WHERE a.space_id=e.space_id AND a.collection_id=e.collection_id AND a.claim_id=e.entity_id) AS cited
        FROM entity_refs e WHERE e.space_id=$1 AND e.collection_id=$2 AND e.kind=$4 AND e.entity_id=$3`,
    [spaceId, endpoint.collectionId, endpoint.id, endpoint.kind])).rows[0];
  return !row || row.tombstone ? null : row.cited as string[];
}
async function readLink(db: Db, scope: AuthorityScope, linkId: string): Promise<Record<string, unknown> | undefined> {
  return (await db.query(`${linkSelect} WHERE l.space_id=$1 AND l.collection_id=$2 AND l.link_id=$3`,
    [scope.spaceId, scope.collectionId, linkId])).rows[0];
}

/**
 * Typed links between records, sources and claims of one space. A link is
 * owned by one of its endpoints' collections and grants nothing: creating or
 * deleting one needs the read and write capability of each endpoint's kind
 * on that endpoint's collection, and a link is read only by a caller who
 * could read both endpoints directly. Deleting an endpoint follows the
 * link's policy: `restrict` refuses the deletion with `LINK_RESTRICTED`,
 * `detach` tombstones the link with the endpoint (migration 044).
 */
export class PostgresLinks {
  constructor(private readonly spaces: PostgresSpaces, private readonly cells: ReadonlyMap<string, LinkCell>) {}

  private async tx<T>(actor: VerifiedCredential, spaceId: string, collectionId: string,
    fn: (db: Db, access: Access, scope: AuthorityScope) => Promise<T>): Promise<T> {
    // Admission resolves placement and identity; every capability is fenced inside the transaction.
    const admitted = await this.spaces.scope(actor, spaceId, collectionId, 'records:read');
    const cell = this.cells.get(admitted.cellId);
    if (!cell) throw new AuthorityError('STALE_PLACEMENT');
    const scope = admitted.scope;
    try {
      return await transact(cell.pool, async db => {
        const access = new Access(db, scope);
        try {
          await access.enter(scope.collectionId);
          const result = await fn(db, access, scope);
          await access.recheck();
          // The provider is asked last, then every grant is checked in one statement with no await between them.
          await this.spaces.assertCurrent(actor, admitted.ownerPrincipalId);
          if (actor.kind === 'api-key') await assertGrantsCurrent(db, scope, admitted.ownerPrincipalId, access);
          return result;
        } finally { access.close(); }
      });
    } catch (error) {
      // An endpoint deleted after it was checked: the link guard refused it.
      if (linkLiveEndpoint(error)) throw new AuthorityError('NOT_FOUND', 'Link endpoint not found');
      throw evidenceRefusal(error);
    }
  }

  /**
   * Link `from` to `to`, owned by `collectionId`, which must be one of their
   * collections. Needs, on each endpoint's collection, the read and write
   * capability of its kind; refused with FORBIDDEN before any endpoint is
   * looked up. A missing, deleted or invisible endpoint is NOT_FOUND. The
   * link ID is derived from the credential and idempotency key: a retry with
   * the same request replays it.
   */
  async create(actor: VerifiedCredential, spaceId: string, collectionId: string, request: unknown): Promise<LinkView> {
    return this.tx(actor, spaceId, collectionId, async (db, access, scope) => {
      const input = fields(request, createFields, createFields);
      const key = idempotencyKey(input.idempotencyKey);
      if (!boundedText(input.type, linkBounds.typeBytes)) invalid('Invalid link type');
      const type = input.type;
      const policy = input.policy;
      if (policy !== 'restrict' && policy !== 'detach') invalid('policy must be restrict or detach');
      const from = endpoint(input.from);
      const to = endpoint(input.to);
      if (sameEndpoint(from, to)) invalid('A link joins two different endpoints');
      if (from.collectionId !== scope.collectionId && to.collectionId !== scope.collectionId)
        invalid('A link is owned by one of its endpoints\' collections');
      const sides: readonly LinkEndpoint[] = [from, to];
      for (let i = 0; i < 2; i++) await access.require(at(sides, i).collectionId, readOf(at(sides, i).kind), 'FORBIDDEN');
      for (let i = 0; i < 2; i++) await access.require(at(sides, i).collectionId, writeOf(at(sides, i).kind), 'FORBIDDEN');
      const linkId = derivedLinkId(scope.credentialId, key);
      await lockLink(db, scope.spaceId, linkId);
      const existing = (await db.query(`${linkSelect} WHERE l.space_id=$1 AND l.link_id=$2`, [scope.spaceId, linkId])).rows[0];
      if (existing) {
        // The stored link is authorized as delete would authorize it before its content is compared, so a
        // credential that lost access to it learns nothing from a changed retry.
        const stored = endpointsOf(existing);
        await access.see(at(stored, 0), existing.from_cited as string[]);
        await access.see(at(stored, 1), existing.to_cited as string[]);
        for (let i = 0; i < 2; i++) await access.require(at(stored, i).collectionId, writeOf(at(stored, i).kind), 'FORBIDDEN');
        if (existing.collection_id !== scope.collectionId || existing.link_type !== type || existing.deletion_policy !== policy ||
          !sameEndpoint(at(stored, 0), from) || !sameEndpoint(at(stored, 1), to)) throw new AuthorityError('IDEMPOTENCY_MISMATCH');
        return linkView(existing, true);
      }
      await writable(db, scope);
      for (let i = 0; i < 2; i++) {
        const side = at(sides, i);
        await writable(db, { ...scope, collectionId: side.collectionId as AuthorityScope['collectionId'] });
        const cited = await liveEndpoint(db, scope.spaceId, side);
        if (!cited) throw new AuthorityError('NOT_FOUND', 'Link endpoint not found');
        await access.see(side, cited);
      }
      // Migration 040's guard rewrites both endpoints, so a concurrent deletion conflicts with this insert.
      await db.query(`INSERT INTO links(space_id,collection_id,link_id,link_type,deletion_policy,from_kind,from_collection_id,
          from_id,to_kind,to_collection_id,to_id,credential_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [scope.spaceId, scope.collectionId, linkId, type, policy, from.kind, from.collectionId, from.id, to.kind, to.collectionId,
        to.id, scope.credentialId]);
      await evidenceEvent(db, scope, 'link', linkId, 1, 'create');
      return linkView((await readLink(db, scope, linkId))!, false);
    });
  }

  /** Read one live link of the collection; NOT_FOUND unless the caller could read both endpoints. */
  async get(actor: VerifiedCredential, spaceId: string, collectionId: string, linkId: string): Promise<LinkView> {
    return this.tx(actor, spaceId, collectionId, async (db, access, scope) => {
      if (!reference(linkId)) throw new AuthorityError('NOT_FOUND');
      const row = await readLink(db, scope, linkId);
      if (!row || row.tombstone) throw new AuthorityError('NOT_FOUND');
      const sides = endpointsOf(row);
      await access.see(at(sides, 0), row.from_cited as string[]);
      await access.see(at(sides, 1), row.to_cited as string[]);
      return linkView(row, false);
    });
  }

  /**
   * Delete a link: tombstone it with a deletion event and its projection
   * invalidation. Needs what creating it needs. A link the caller could not
   * read is NOT_FOUND. Deleting a deleted link, including one detached with
   * its endpoint, replays.
   */
  async delete(actor: VerifiedCredential, spaceId: string, collectionId: string, linkId: string): Promise<LinkDeletion> {
    return this.tx(actor, spaceId, collectionId, async (db, access, scope) => {
      if (!reference(linkId)) throw new AuthorityError('NOT_FOUND');
      await lockLink(db, scope.spaceId, linkId);
      const row = await readLink(db, scope, linkId);
      if (!row) throw new AuthorityError('NOT_FOUND');
      const sides = endpointsOf(row);
      await access.see(at(sides, 0), row.from_cited as string[]);
      await access.see(at(sides, 1), row.to_cited as string[]);
      for (let i = 0; i < 2; i++) await access.require(at(sides, i).collectionId, writeOf(at(sides, i).kind), 'FORBIDDEN');
      if (row.tombstone) return { ...linkView(row, true), erasure: { ...rowsRetained } };
      await writable(db, scope);
      for (let i = 0; i < 2; i++)
        await writable(db, { ...scope, collectionId: at(sides, i).collectionId as AuthorityScope['collectionId'] });
      const tombstoned = await db.query(`UPDATE links SET revision=revision+1,tombstone=true,tombstoned_at=clock_timestamp()
        WHERE space_id=$1 AND collection_id=$2 AND link_id=$3 AND NOT tombstone RETURNING revision`,
      [scope.spaceId, scope.collectionId, linkId]);
      // An endpoint deletion detached it first.
      if (tombstoned.rowCount !== 1) return { ...linkView((await readLink(db, scope, linkId))!, true), erasure: { ...rowsRetained } };
      await evidenceEvent(db, scope, 'link', linkId, Number(tombstoned.rows[0].revision), 'delete');
      return { ...linkView((await readLink(db, scope, linkId))!, false), erasure: { ...rowsRetained } };
    });
  }

  /**
   * List the live links touching one endpoint in the collection, from either
   * side and whichever collection owns them, in link ID order. The caller
   * needs the endpoint's read capability (FORBIDDEN otherwise) and must see
   * the endpoint (NOT_FOUND otherwise). A link whose other endpoint the
   * caller could not read directly is omitted, so nothing about it shows.
   */
  async list(actor: VerifiedCredential, spaceId: string, collectionId: string, query: unknown): Promise<LinkPage> {
    return this.tx(actor, spaceId, collectionId, async (db, access, scope) => {
      const input = fields(query, listFields, ['endpoint']);
      const wanted = fields(input.endpoint, listEndpointFields, listEndpointFields);
      const kind = endpointKind(wanted.kind);
      if (!reference(wanted.id)) invalid('Invalid link endpoint');
      const self: LinkEndpoint = { kind, collectionId: scope.collectionId, id: wanted.id };
      const after = input.after === undefined ? null : input.after;
      if (after !== null && !reference(after)) invalid('Invalid after');
      const limit = input.limit === undefined ? linkBounds.page : input.limit;
      if (!isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > linkBounds.page)
        invalid('limit is outside the page bound');
      await access.require(self.collectionId, readOf(kind), 'FORBIDDEN');
      const cited = await liveEndpoint(db, scope.spaceId, self);
      if (!cited) throw new AuthorityError('NOT_FOUND');
      await access.see(self, cited);
      // Only links the caller could read are selected, so a page never reports, counts or skips past the others.
      const rows = (await db.query(`${linkSelect} WHERE l.space_id=$1 AND NOT l.tombstone
          AND ((l.from_collection_id=$2 AND l.from_kind=$3 AND l.from_id=$4) OR (l.to_collection_id=$2 AND l.to_kind=$3 AND l.to_id=$4))
          AND ($5::text IS NULL OR l.link_id COLLATE "C">$5::text) AND ${visibleSql('from')} AND ${visibleSql('to')}
        ORDER BY l.link_id COLLATE "C" LIMIT $9`, [scope.spaceId, self.collectionId, kind, self.id, after,
        await access.holding('records:read'), await access.holding('sources:read'), await access.holding('claims:read'),
        (limit as number) + 1])).rows;
      // The row past the page decides `next`, so it is admitted and fenced like the page's own rows.
      const admitted: LinkView[] = [];
      for (let i = 0; i < rows.length; i++) {
        const sides = endpointsOf(rows[i]);
        await access.see(at(sides, 0), rows[i].from_cited as string[]);
        await access.see(at(sides, 1), rows[i].to_cited as string[]);
        put(admitted, linkView(rows[i], false));
      }
      const links: LinkView[] = [];
      for (let i = 0; i < admitted.length && i < (limit as number); i++) put(links, at(admitted, i));
      const next = admitted.length > (limit as number) ? at(links, (limit as number) - 1).linkId : null;
      return { links, next };
    });
  }
}
