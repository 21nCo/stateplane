import { createHmac, timingSafeEqual } from 'node:crypto';

/** How long the local and Preview host keeps an idempotency receipt. Retention is
 * configured, never indefinite (contracts/v1.md); the UI's retry deadline reads
 * this same value. */
export const receiptRetentionSeconds=3600;
/** A retry is offered until this long before the receipt can first expire. The UI
 * and the database each compare times on their own clock, so a clock offset
 * cancels; the margin covers the retry's travel to the receipt lookup (the host's
 * request timeout is 12 s) and clock drift. A protective choice, not a measurement. */
export const retryMarginSeconds=60;

/** An unresolved write as its form posts it back: its key, its exact request, the
 * server time it was first sent and a server signature over all three. */
export interface Sealed { key:string; sent:string; at:string; seal:string }

const sign=(secret:Buffer,key:string,sent:string,at:string)=>
  createHmac('sha256',secret).update(JSON.stringify([key,sent,at])).digest('base64url');
/** The host's cursor secret, domain-separated, signs when each write was first sent. */
export const sealSecret=(hex?:string)=>hex && /^[0-9a-fA-F]{64,}$/.test(hex) ?
  createHmac('sha256',Buffer.from(hex,'hex')).update('stateplane-ui-unresolved-write-v1').digest() : null;
export const seal=(secret:Buffer|null,key:string,sent:string,now:number):Sealed=>
  ({key,sent,at:String(now),seal:secret ? sign(secret,key,sent,String(now)) : ''});
/** The last instant its retry may be sent, or null when its stamp is missing or
 * altered: a posted time can never extend the window. */
export function retryDeadline(secret:Buffer|null,write:Sealed):number|null {
  if (!secret || !/^\d{1,15}$/.test(write.at)) return null;
  const expected=Buffer.from(sign(secret,write.key,write.sent,write.at)), given=Buffer.from(write.seal);
  return expected.length===given.length && timingSafeEqual(expected,given) ?
    Number(write.at)+(receiptRetentionSeconds-retryMarginSeconds)*1000 : null;
}
