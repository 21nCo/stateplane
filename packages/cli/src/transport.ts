import { isSafeHttpRead, parseV1Path } from '@stateplane/contracts';

export class StateplaneCliError extends Error {
  readonly retryable:boolean;
  constructor(readonly code:string,readonly requestId?:string,readonly retryAfter?:number,retryable?:boolean) {
    super(code); this.name='StateplaneCliError';
    this.retryable=retryable??['RECEIPT_PENDING','PROVIDER_UNAVAILABLE','BACKPRESSURE','RATE_LIMITED','STALE_PLACEMENT'].includes(code);
  }
}

export interface ClientOptions {
  endpoint:string; token:string; fetch?:typeof fetch; timeoutMs?:number; sleep?:(ms:number)=>Promise<void>;
}

function serializeBody(body:unknown):string|undefined {
  if (body===undefined) return undefined;
  let serialized:string|undefined;
  try { serialized=JSON.stringify(body); }
  catch { throw new StateplaneCliError('INVALID_ARGUMENT'); }
  if (serialized===undefined) throw new StateplaneCliError('INVALID_ARGUMENT');
  return serialized;
}

function retryAfter(response:Response):number|undefined {
  const header=response.headers.get('retry-after');
  return header && /^\d+$/.test(header) ? Math.min(5,Number(header)) : undefined;
}

function serverError(value:unknown,after:number|undefined):StateplaneCliError {
  const envelope=value as {error?:{code?:unknown;retryable?:unknown;requestId?:unknown}};
  const code=typeof envelope?.error?.code==='string' && /^[A-Z_]{1,64}$/.test(envelope.error.code)
    ? envelope.error.code : 'PROVIDER_UNAVAILABLE';
  const requestId=typeof envelope?.error?.requestId==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(envelope.error.requestId)
    ? envelope.error.requestId : undefined;
  return new StateplaneCliError(code,requestId,after,
    typeof envelope?.error?.retryable==='boolean' ? envelope.error.retryable : undefined);
}
class WireFailure extends Error {}
/** Keep provider exceptions out of CLI output, including verbose paths. */
async function wireFetch(fetcher:typeof fetch,url:URL,options:RequestInit):Promise<Response> {
  try { return await fetcher(url,options); }
  catch { throw new WireFailure(); }
}
async function wireJson(response:Response):Promise<unknown> {
  try { return await response.json(); }
  catch { throw new WireFailure(); }
}

/** A thin HTTP client. Only read requests may be repeated automatically. */
export class StateplaneHttpClient {
  private readonly endpoint:URL;
  private readonly token:string;
  private readonly fetcher:typeof fetch;
  private readonly timeoutMs:number;
  private readonly sleep:(ms:number)=>Promise<void>;
  constructor(options:ClientOptions) {
    const token=options.token;
    try { this.endpoint=new URL(options.endpoint); }
    catch { throw new StateplaneCliError('INVALID_CONFIGURATION'); }
    if (!['https:','http:'].includes(this.endpoint.protocol) ||
        (this.endpoint.protocol==='http:' && !['localhost','127.0.0.1','[::1]'].includes(this.endpoint.hostname)) ||
        this.endpoint.username || this.endpoint.password ||
        this.endpoint.search || this.endpoint.hash || this.endpoint.pathname!=='/' || !token)
      throw new StateplaneCliError('INVALID_CONFIGURATION');
    this.token=token;
    this.fetcher=options.fetch??fetch;
    this.timeoutMs=options.timeoutMs??30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs<1 || this.timeoutMs>120_000)
      throw new StateplaneCliError('INVALID_CONFIGURATION');
    this.sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  }
  /** One wire attempt; only an explicit safe-read response can request a repeat. */
  private async exchange(method:string,url:URL,serialized:string|undefined,
    extraHeaders:Record<string,string>|undefined,safeRead:boolean,attempt:number):
    Promise<{retry:true}|{retry:false;value:unknown}> {
    const response=await wireFetch(this.fetcher,url,{method,redirect:'error',signal:AbortSignal.timeout(this.timeoutMs),
      headers:{Authorization:`Bearer ${this.token}`,Accept:'application/json',
        ...(serialized===undefined?{}:{'Content-Type':'application/json'}),...extraHeaders},
      body:serialized});
    const after=retryAfter(response);
    if (safeRead && attempt<2 && [429,503].includes(response.status) && after!==undefined) {
      await response.body?.cancel().catch(()=>{});
      await this.sleep(after*1000);
      return {retry:true};
    }
    const value=await wireJson(response);
    if (!response.ok) throw serverError(value,after);
    return {retry:false,value};
  }
  /** Resolve the route before any bearer token is attached to a request. */
  private route(path:string):{url:URL;segments:string[]} {
    if (!path.startsWith('/v1/') || path.startsWith('//')) throw new StateplaneCliError('INVALID_ARGUMENT');
    let url:URL;
    try { url=new URL(path,this.endpoint); }
    catch { throw new StateplaneCliError('INVALID_ARGUMENT'); }
    const segments=parseV1Path(url.pathname);
    if (url.origin!==this.endpoint.origin || !segments) throw new StateplaneCliError('INVALID_ARGUMENT');
    return {url,segments};
  }
  /** A wire failure is ambiguous for writes, but a read can be repeated twice. */
  private async recoverWireFailure(safeRead:boolean,attempt:number):Promise<void> {
    if (!safeRead) throw new StateplaneCliError('OUTCOME_UNKNOWN');
    if (attempt>=2) throw new StateplaneCliError('PROVIDER_UNAVAILABLE');
    await this.sleep(250*(attempt+1));
  }
  /** Validate the route once, then bound retries to read-only operations. */
  async request(method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',path:string,body?:unknown,
    extraHeaders?:Record<string,string>):Promise<unknown> {
    const {url,segments}=this.route(path);
    const safeRead=isSafeHttpRead(method,segments);
    const serialized=serializeBody(body);
    for (let attempt=0;attempt<(safeRead?3:1);attempt++) {
      try {
        const result=await this.exchange(method,url,serialized,extraHeaders,safeRead,attempt); // NOSONAR -- each retry depends on the preceding response
        if (result.retry) continue;
        return result.value;
      } catch(error) {
        if (!(error instanceof WireFailure)) throw error;
        await this.recoverWireFailure(safeRead,attempt); // NOSONAR -- bounded read retries must remain sequential
      }
    }
    throw new StateplaneCliError('PROVIDER_UNAVAILABLE');
  }
}
