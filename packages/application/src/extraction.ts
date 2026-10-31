/**
 * One extracted content range and the original's byte range it came from.
 * `start`/`end` count Unicode code points of the extraction's content, as
 * Postgres `char_length` and `substring` do; `sourceStart`/`sourceEnd` count
 * bytes of the original. Both ranges are half-open.
 */
export interface ExtractionSegment { start: number; end: number; sourceStart: number; sourceEnd: number }
/** A parser's output: text and the segments that map it back to the original. */
export interface TextExtraction { content: string; sourceOffsets: ExtractionSegment[] }
/**
 * A bounded, deterministic text parser for an explicit list of MIME essences.
 * `parse` receives the whole verified original and throws `ExtractionError`
 * for input it refuses; its output must pass `checkExtraction`.
 */
export interface TextParser {
  readonly name: string; readonly version: string; readonly mimeTypes: readonly string[];
  parse(bytes: Uint8Array): TextExtraction;
}

/** Initial bounds; docs/evidence-storage.md records the evidence for each. */
export const extractionBounds = Object.freeze({ sourceBytes: 1_048_576, contentBytes: 1_048_576, segments: 4_096 });

/** Why an extraction was refused. `unsupported`: no parser for the MIME type.
 * `size`: the original exceeds the parser's bound. `encoding`: it is not
 * well-formed UTF-8. `content`: the text is not storable (NUL) or exceeds its
 * bound. `offsets`: a segment is malformed, out of range or out of order. */
export type ExtractionFailure = 'unsupported' | 'size' | 'encoding' | 'content' | 'offsets';
export class ExtractionError extends Error {
  constructor(readonly reason: ExtractionFailure) { super(`Extraction refused: ${reason}`); this.name = 'ExtractionError'; }
}

// Captured at load, so a later change to a global or prototype cannot alter a decision.
const codeUnit = String.prototype.charCodeAt;
const isSafeInteger = Number.isSafeInteger;
const isArray = Array.isArray;
const hasOwn = Object.hasOwn;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const Decoder = TextDecoder;
/**
 * Code points and UTF-8 bytes of well-formed text without NUL, read by code
 * unit; null for a NUL or a lone surrogate.
 */
export function measureText(text: string): { codePoints: number; bytes: number } | null {
  let codePoints = 0;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = Reflect.apply(codeUnit, text, [i]) as number;
    if (unit === 0 || (unit >= 0xdc00 && unit <= 0xdfff)) return null;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = Reflect.apply(codeUnit, text, [++i]) as number;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
      bytes += 4;
    } else bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    codePoints++;
  }
  return { codePoints, bytes };
}

/**
 * Check an extraction against the contract for an original of `sourceBytes`:
 * storable text within the content bound, at most `segments` segments, each
 * a nonempty content range within the text and a byte range within the
 * original, in content order without overlap. Byte ranges may be empty, for
 * text that has no source position, and need not be ordered.
 */
export function checkExtraction(output: TextExtraction, sourceBytes: number): void {
  const { content, sourceOffsets } = output;
  if (typeof content !== 'string' || content.length > extractionBounds.contentBytes) throw new ExtractionError('content');
  const measured = measureText(content);
  if (!measured || measured.bytes > extractionBounds.contentBytes) throw new ExtractionError('content');
  if (!isArray(sourceOffsets) || sourceOffsets.length > extractionBounds.segments) throw new ExtractionError('offsets');
  let previousEnd = 0;
  for (let i = 0; i < sourceOffsets.length; i++) {
    // A hole, an accessor or a non-object segment is refused like any other malformed one.
    const descriptor = ownDescriptor(sourceOffsets, i);
    const segment: unknown = descriptor && hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    if (typeof segment !== 'object' || segment === null) throw new ExtractionError('offsets');
    const { start, end, sourceStart, sourceEnd } = segment as ExtractionSegment;
    if (!isSafeInteger(start) || !isSafeInteger(end) || !isSafeInteger(sourceStart) || !isSafeInteger(sourceEnd) ||
      start < previousEnd || end <= start || end > measured.codePoints ||
      sourceStart < 0 || sourceEnd < sourceStart || sourceEnd > sourceBytes) throw new ExtractionError('offsets');
    previousEnd = end;
  }
}

const bom = [0xef, 0xbb, 0xbf];
/**
 * The generic text parser: the original decoded as UTF-8, verbatim except for
 * one leading byte order mark, with no newline or Unicode normalization. Its
 * one segment therefore maps the content to the original byte for byte.
 */
export const textParser: TextParser = Object.freeze({
  name: 'stateplane.text',
  version: '1',
  mimeTypes: Object.freeze(['text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values']),
  parse(bytes: Uint8Array): TextExtraction {
    if (bytes.byteLength > extractionBounds.sourceBytes) throw new ExtractionError('size');
    const skip = bytes.byteLength >= 3 && bytes[0] === bom[0] && bytes[1] === bom[1] && bytes[2] === bom[2] ? 3 : 0;
    let content: string;
    // ignoreBOM keeps any further U+FEFF as content; only the one skipped above is dropped.
    try { content = new Decoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(skip)); }
    catch { throw new ExtractionError('encoding'); }
    const measured = measureText(content);
    if (!measured) throw new ExtractionError('content');
    const output = { content, sourceOffsets: measured.codePoints === 0 ? [] :
      [{ start: 0, end: measured.codePoints, sourceStart: skip, sourceEnd: bytes.byteLength }] };
    checkExtraction(output, bytes.byteLength);
    return output;
  }
});

const parsers: readonly TextParser[] = Object.freeze([textParser]);
/** The parser for a MIME essence, or null when the type is not supported. */
export function parserFor(mimeType: string | null): TextParser | null {
  for (let i = 0; i < parsers.length; i++) {
    const parser = parsers[i];
    for (let j = 0; j < parser.mimeTypes.length; j++) if (parser.mimeTypes[j] === mimeType) return parser;
  }
  return null;
}
