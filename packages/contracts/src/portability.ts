/**
 * The open, versioned space export format (docs/portability-export.md): a
 * space's parts, each one section's NDJSON, and the manifest that seals them.
 * The JSON Schema of the manifest and of every section's rows is
 * contracts/portability-manifest.schema.json.
 */
export const portabilityFormat = 'stateplane.space-export';
export const portabilityFormatVersion = 1;

/**
 * The sections of an export, in the order its parts carry them. Each part
 * holds one section's NDJSON stream from where the previous part of that
 * section stopped; a line may continue into the next part. `manifest` is the
 * last part and seals the rest. `permissions` comes first: grants have no
 * history, so they are read while the policy version is still the one the
 * export was admitted under.
 */
export const exportSections = Object.freeze(['permissions', 'schemas', 'retrieval', 'sources', 'extractions', 'claims',
  'provenance', 'links', 'events', 'records', 'revisions'] as const);
export type ExportSection = typeof exportSections[number];
/** Optional accelerator sections: never the only copy of anything, and an importer may ignore them. */
export const acceleratorSections = Object.freeze(['embeddings'] as const);

export interface ExportManifestPart { number: number; section: string; rows: number; bytes: number; sha256: string }
export interface ExportManifest {
  format: typeof portabilityFormat;
  formatVersion: number;
  jobId: string;
  space: { spaceId: string; ownerPrincipalId: string; policyVersion: number; placementGeneration: number };
  /**
   * Records are as of `watermark`, a position of the cell's record event feed;
   * every other section as of `snapshotAt`, the instant the watermark was
   * pinned while writes to the space were held. Both name the same state.
   */
  boundary: { watermark: number; snapshotAt: string; records: 'as-of-watermark'; evidence: 'as-of-snapshot' };
  sections: { name: string; rows: number; bytes: number; accelerator: boolean }[];
  parts: ExportManifestPart[];
  /** What the export never carries, whatever the space holds. */
  excluded: string[];
}

export type ManifestVerification =
  | { ok: true; manifest: ExportManifest }
  | { ok: false; reason: string };

const HEX64 = /^[0-9a-f]{64}$/;
const JOB_ID = /^exp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECTION_NAME = /^[a-z][a-z0-9_]{0,62}$/;
// RFC 3339 date-time, as the schema's `format: date-time` names it: a calendar date, a time of day and an offset.
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/i;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** RFC 3339 section 5.7: the day exists in its month and year, and a second of 60 is only a leap second, 23:59:60 UTC. */
function isInstant(value: unknown): boolean {
  const match = typeof value === 'string' ? INSTANT.exec(value) : null;
  if (!match) return false;
  const [year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match.slice(1).map(part => Number(part ?? 0));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (month < 1 || month > 12 || day < 1 || day > (month === 2 && leap ? 29 : DAYS[month - 1])) return false;
  if (offsetHour > 23 || offsetMinute > 59) return false;
  if (hour <= 23 && minute <= 59 && second <= 59) return true;
  const sign = match[7] === '-' ? -1 : 1, utcMinute = minute - offsetMinute * sign;
  const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0);
  return second === 60 && (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1);
}
/** The manifest schema's limits: 11 evidence sections and at most 1 accelerator; 4,095 data parts of 1 to 1 MiB. */
const MAX_DATA_PARTS = 4_095;
const MAX_PART_BYTES = 1_048_576;
const encoder = new TextEncoder();
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isPositive = (value: unknown): value is number => isCount(value) && value >= 1;
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
/** A JSON object with exactly the members `names`, as every object of the format is closed and its members required. */
const closed = (value: unknown, names: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const members = Object.keys(value);
  return members.length === names.length && names.every(name => Object.prototype.hasOwnProperty.call(value, name));
};

/** The lowercase hex SHA-256 of `content`'s UTF-8 bytes. */
export async function sha256Hex(content: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(content)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The reason `value` is not a manifest of format version 1, or null: every
 * rule of contracts/portability-manifest.schema.json (required members,
 * closed objects, types, patterns and limits) and the rules the schema cannot
 * state (section order, part numbering and section totals).
 */
function malformed(value: unknown): string | null {
  if (!closed(value, ['format', 'formatVersion', 'jobId', 'space', 'boundary', 'sections', 'parts', 'excluded']))
    return 'the manifest is not a closed object with exactly the version 1 members';
  const m = value as unknown as ExportManifest;
  if (m.format !== portabilityFormat) return `format is not ${portabilityFormat}`;
  if (m.formatVersion !== portabilityFormatVersion) return `formatVersion ${String(m.formatVersion)} is not supported`;
  if (typeof m.jobId !== 'string' || !JOB_ID.test(m.jobId)) return 'jobId is malformed';
  const s = m.space;
  if (!closed(s, ['spaceId', 'ownerPrincipalId', 'policyVersion', 'placementGeneration']) || !isId(s.spaceId)
    || !isId(s.ownerPrincipalId) || !isPositive(s.policyVersion) || !isPositive(s.placementGeneration)) return 'space is malformed';
  const b = m.boundary;
  if (!closed(b, ['watermark', 'snapshotAt', 'records', 'evidence']) || !isCount(b.watermark) || !isInstant(b.snapshotAt)
    || b.records !== 'as-of-watermark' || b.evidence !== 'as-of-snapshot') return 'the boundary is malformed';
  if (!Array.isArray(m.excluded) || m.excluded.some(item => typeof item !== 'string')) return 'excluded is malformed';
  if (!Array.isArray(m.parts) || !Array.isArray(m.sections)) return 'parts and sections must be arrays';
  if (m.parts.length > MAX_DATA_PARTS) return `more than ${MAX_DATA_PARTS} data parts`;
  const known: readonly string[] = [...exportSections, ...acceleratorSections];
  if (m.sections.length < exportSections.length || m.sections.length > known.length) return 'sections has the wrong length';
  for (const section of m.sections)
    if (!closed(section, ['name', 'rows', 'bytes', 'accelerator']) || !isCount(section.rows) || !isCount(section.bytes)
      || typeof section.accelerator !== 'boolean') return 'a section is malformed';
  const order = m.sections.map(section => section.name);
  if (order.some(name => !known.includes(name)) || new Set(order).size !== order.length)
    return 'sections name an unknown or repeated section';
  // Sections appear in the format's order; an accelerator is optional and every evidence section is present.
  const ranked = order.map(name => known.indexOf(name));
  if (ranked.some((rank, i) => i > 0 && rank < ranked[i - 1])) return 'sections are out of order';
  if (exportSections.some(name => !order.includes(name))) return 'an evidence section is missing';
  if (m.sections.some(section => section.accelerator !== (acceleratorSections as readonly string[]).includes(section.name)))
    return 'only embeddings is an accelerator';
  const totals = new Map<string, { rows: number; bytes: number }>(order.map(name => [name, { rows: 0, bytes: 0 }]));
  let at = -1;
  for (const [i, part] of m.parts.entries()) {
    if (!closed(part, ['number', 'section', 'rows', 'bytes', 'sha256']) || part.number !== i + 1 || !isCount(part.rows)
      || !isPositive(part.bytes) || part.bytes > MAX_PART_BYTES || typeof part.section !== 'string' || !SECTION_NAME.test(part.section)
      || typeof part.sha256 !== 'string' || !HEX64.test(part.sha256))
      return `part ${i + 1} is malformed or out of sequence`;
    const rank = order.indexOf(part.section);
    // A section's parts are contiguous, in the sections' order.
    if (rank < at || rank < 0) return `part ${part.number} is out of section order`;
    at = rank;
    const total = totals.get(part.section)!;
    total.rows += part.rows; total.bytes += part.bytes;
  }
  for (const section of m.sections)
    if (totals.get(section.name)!.rows !== section.rows || totals.get(section.name)!.bytes !== section.bytes)
      return `section ${section.name} does not total its parts`;
  return null;
}

/**
 * Verify an export manifest against its SHA-256 digest (the job states it;
 * the manifest is the export's last part) and, when given, every data part
 * (`parts[i]` the content of part i + 1) against the size and digest the
 * manifest lists. Any changed byte of the manifest, or of a part it lists,
 * fails verification; a manifest with no digest to check is never trusted.
 */
export async function verifyExportManifest(manifestText: string, expectedSha256: string,
  parts?: readonly string[]): Promise<ManifestVerification> {
  if (typeof manifestText !== 'string' || typeof expectedSha256 !== 'string' || !HEX64.test(expectedSha256))
    return { ok: false, reason: 'a manifest and its lowercase hex SHA-256 digest are required' };
  if (await sha256Hex(manifestText) !== expectedSha256) return { ok: false, reason: 'the manifest does not match its digest' };
  let manifest: unknown;
  try { manifest = JSON.parse(manifestText); } catch { return { ok: false, reason: 'the manifest is not JSON' }; }
  const reason = malformed(manifest);
  if (reason) return { ok: false, reason };
  const sealed = manifest as ExportManifest;
  if (parts !== undefined) {
    if (parts.length !== sealed.parts.length) return { ok: false, reason: `the manifest lists ${sealed.parts.length} parts, ${parts.length} given` };
    for (const [i, listed] of sealed.parts.entries()) {
      const content = parts[i];
      if (typeof content !== 'string' || encoder.encode(content).byteLength !== listed.bytes || await sha256Hex(content) !== listed.sha256)
        return { ok: false, reason: `part ${listed.number} does not match the manifest` };
    }
  }
  return { ok: true, manifest: sealed };
}
