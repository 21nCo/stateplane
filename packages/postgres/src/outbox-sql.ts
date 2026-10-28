// Shared delivery-state SQL for collection-scoped and cell-wide outbox paths.

/** Initial poison bound: about ten minutes of backoff before parking. Not a measured provider limit. */
export const MAX_PROJECTION_FAILURES = 8;
export const LIVE_OUTBOX = `delivery_state IN ('pending','delivering','degraded')`;
/** Live rows with a failure, matching the `projection_outbox_failed` partial index. */
export const FAILED_OUTBOX = `${LIVE_OUTBOX} AND (failures>0 OR delivery_state='degraded')`;

// A lease that was started by a worker and then expired is a failed attempt:
// the worker crashed or overran. An expired lease that was never started is
// a lost dispatch and costs nothing.
const expired = `(CASE WHEN o.delivery_state='delivering' AND o.started_attempt=o.attempts THEN 1 ELSE 0 END)`;
const parked = `o.failures+${expired}>=${MAX_PROJECTION_FAILURES}`;

/**
 * Lease the locked rows selected by `due` (an `event_id` column). Rows whose
 * failure budget is spent become dead letters instead; they are returned
 * with `parked` set, so a caller can tell parking from an idle claim. Each
 * `carry` column of `due` is returned with its row.
 */
export function claimOutboxSql(due: string, leaseSeconds: string, started: string, carry: readonly string[] = []): string {
  return `WITH due AS (${due}), claimed AS (
    UPDATE projection_outbox o SET attempts=o.attempts+1, failures=o.failures+${expired},
      last_error=CASE WHEN ${expired}=1 THEN 'Processing lease expired' ELSE o.last_error END,
      delivery_state=CASE WHEN ${parked} THEN 'degraded' ELSE 'delivering' END,
      dead_lettered_at=CASE WHEN ${parked} THEN clock_timestamp() END,
      available_at=CASE WHEN ${parked} THEN 'infinity'::timestamptz
        ELSE clock_timestamp()+(${leaseSeconds}::integer * interval '1 second') END,
      started_attempt=CASE WHEN ${started}::boolean THEN o.attempts+1 END
    FROM due WHERE o.event_id=due.event_id
    RETURNING o.event_id,o.space_id,o.collection_id,o.record_id,o.revision,o.generation,o.attempts,o.delivery_state${carry.map(column => `,due.${column}`).join('')})
  SELECT event_id,space_id,collection_id,record_id,revision,generation,attempts,delivery_state='degraded' AS parked
    ${carry.map(column => `,${column}`).join('')} FROM claimed ORDER BY event_id`;
}

/**
 * Record a failed, still-current lease: $1 space, $2 collection, $3 event,
 * $4 attempt, $5 revision, $6 generation, $7 error. Backoff starts at five
 * seconds and doubles to one hour; the last allowed failure parks the row.
 */
export const failOutboxSql = `UPDATE projection_outbox SET failures=failures+1, last_error=$7,
    delivery_state='degraded', started_attempt=NULL,
    dead_lettered_at=CASE WHEN failures+1>=${MAX_PROJECTION_FAILURES} THEN clock_timestamp() END,
    available_at=CASE WHEN failures+1>=${MAX_PROJECTION_FAILURES} THEN 'infinity'::timestamptz
      ELSE clock_timestamp()+(LEAST(3600, 5 * (1 << LEAST(failures, 10))) * interval '1 second') END
  WHERE space_id=$1 AND collection_id=$2 AND event_id=$3 AND attempts=$4 AND revision=$5 AND generation=$6
    AND delivery_state='delivering' AND available_at>clock_timestamp()`;

/**
 * Re-project every live collection of space $1 after a placement fence. A
 * running pass restarts from the first record, because records it already
 * scanned were checked against the earlier generation.
 */
export const schedulePlacementRepairSql = `INSERT INTO projection_reconciliations(job_id,space_id,collection_id,cause)
    SELECT 'rcn_'||gen_random_uuid(),space_id,collection_id,'placement' FROM collections
    WHERE space_id=$1 AND lifecycle<>'deleted' ORDER BY collection_id
  ON CONFLICT (space_id,collection_id) WHERE state='running' DO UPDATE
  SET after_record_id=NULL,cause='placement',next_step_at='-infinity',updated_at=clock_timestamp()`;
