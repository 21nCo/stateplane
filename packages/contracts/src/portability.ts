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
const encoder = new TextEncoder();
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** The lowercase hex SHA-256 of `content`'s UTF-8 bytes. */
export async function sha256Hex(content: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(content)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The structure a manifest must have before its parts are trusted; the reason it fails, or null. */
function malformed(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'the manifest is not a JSON object';
  const m = value as Partial<ExportManifest>;
  if (m.format !== portabilityFormat) return `format is not ${portabilityFormat}`;
  if (m.formatVersion !== portabilityFormatVersion) return `formatVersion ${String(m.formatVersion)} is not supported`;
  const b = m.boundary;
  if (!b || !isCount(b.watermark) || typeof b.snapshotAt !== 'string' || Number.isNaN(Date.parse(b.snapshotAt))
    || b.records !== 'as-of-watermark' || b.evidence !== 'as-of-snapshot') return 'the boundary is malformed';
  if (!Array.isArray(m.parts) || !Array.isArray(m.sections)) return 'parts and sections must be arrays';
  const known: readonly string[] = [...exportSections, ...acceleratorSections];
  const order = m.sections.map(s => s?.name);
  if (order.some(name => !known.includes(name as string)) || new Set(order).size !== order.length)
    return 'sections name an unknown or repeated section';
  // Sections appear in the format's order; an accelerator is optional and every evidence section is present.
  const ranked = order.map(name => known.indexOf(name as string));
  if (ranked.some((rank, i) => i > 0 && rank < ranked[i - 1])) return 'sections are out of order';
  if (exportSections.some(name => !order.includes(name))) return 'an evidence section is missing';
  if (m.sections.some(s => s.accelerator !== (acceleratorSections as readonly string[]).includes(s.name)))
    return 'only embeddings is an accelerator';
  const totals = new Map<string, { rows: number; bytes: number }>(order.map(name => [name as string, { rows: 0, bytes: 0 }]));
  let at = -1;
  for (const [i, part] of m.parts.entries()) {
    if (!part || part.number !== i + 1 || !isCount(part.rows) || !isCount(part.bytes) || part.bytes < 1 || !HEX64.test(part.sha256 ?? ''))
      return `part ${i + 1} is malformed or out of sequence`;
    const rank = order.indexOf(part.section);
    // A section's parts are contiguous, in the sections' order.
    if (rank < at || rank < 0) return `part ${part.number} is out of section order`;
    at = rank;
    const total = totals.get(part.section)!;
    total.rows += part.rows; total.bytes += part.bytes;
  }
  for (const s of m.sections)
    if (!isCount(s.rows) || !isCount(s.bytes) || totals.get(s.name)!.rows !== s.rows || totals.get(s.name)!.bytes !== s.bytes)
      return `section ${s.name} does not total its parts`;
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
