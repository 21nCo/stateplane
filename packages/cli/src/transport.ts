export class StateplaneCliError extends Error {
  constructor(readonly code:string,readonly requestId?:string,readonly retryAfter?:number) {
    super(code); this.name='StateplaneCliError';
  }
}

export interface ClientOptions {
  endpoint:string; token:string; fetch?:typeof fetch; timeoutMs?:number; sleep?:(ms:number)=>Promise<void>;
}

/** A thin HTTP client. Only read requests may be repeated automatically. */
export class StateplaneHttpClient {
  private readonly endpoint:URL;
  private readonly fetcher:typeof fetch;
  private readonly timeoutMs:number;
  private readonly sleep:(ms:number)=>Promise<void>;
  constructor(private readonly options:ClientOptions) {
    this.endpoint=new URL(options.endpoint);
    if (!['https:','http:'].includes(this.endpoint.protocol) ||
        (this.endpoint.protocol==='http:' && !['localhost','127.0.0.1','[::1]'].includes(this.endpoint.hostname)) ||
        this.endpoint.username || this.endpoint.password ||
        this.endpoint.search || this.endpoint.hash || this.endpoint.pathname!=='/' || !options.token)
      throw new StateplaneCliError('INVALID_CONFIGURATION');
    this.fetcher=options.fetch??fetch;
    this.timeoutMs=options.timeoutMs??30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs<1 || this.timeoutMs>120_000)
      throw new StateplaneCliError('INVALID_CONFIGURATION');
    this.sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  }
  async request(method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',path:string,body?:unknown,
    extraHeaders?:Record<string,string>):Promise<unknown> {
    if (!path.startsWith('/v1/') || path.startsWith('//')) throw new StateplaneCliError('INVALID_ARGUMENT');
    const url=new URL(path,this.endpoint);
    if (url.origin!==this.endpoint.origin) throw new StateplaneCliError('INVALID_ARGUMENT');
    const safeRead=method==='GET' || (method==='POST' && /\/records\/(?:query|count)$/.test(new URL(path,this.endpoint).pathname));
    for (let attempt=0;attempt<(safeRead?3:1);attempt++) {
      let response:Response;
      try {
        response=await this.fetcher(url,{method,redirect:'error',signal:AbortSignal.timeout(this.timeoutMs),
          headers:{Authorization:`Bearer ${this.options.token}`,Accept:'application/json',
            ...(body===undefined?{}:{'Content-Type':'application/json'}),...extraHeaders},
          body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
      } catch {
        if (safeRead && attempt<2) { await this.sleep(250*(attempt+1)); continue; }
        throw new StateplaneCliError(safeRead?'PROVIDER_UNAVAILABLE':'OUTCOME_UNKNOWN');
      }
      let value:unknown;
      try { value=await response.json(); }
      catch { throw new StateplaneCliError(safeRead?'PROVIDER_UNAVAILABLE':'OUTCOME_UNKNOWN'); }
      if (response.ok) return value;
      const envelope=value as {error?:{code?:unknown;requestId?:unknown}};
      const code=typeof envelope?.error?.code==='string' && /^[A-Z_]{1,64}$/.test(envelope.error.code)
        ? envelope.error.code : 'PROVIDER_UNAVAILABLE';
      const requestId=typeof envelope?.error?.requestId==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(envelope.error.requestId)
        ? envelope.error.requestId : undefined;
      const retryAfterHeader=response.headers.get('retry-after');
      const retryAfter=retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Math.min(5,Number(retryAfterHeader)) : undefined;
      if (safeRead && attempt<2 && [429,503].includes(response.status) && retryAfter!==undefined) {
        await this.sleep(retryAfter*1000); continue;
      }
      throw new StateplaneCliError(code,requestId,retryAfter);
    }
    throw new StateplaneCliError('PROVIDER_UNAVAILABLE');
  }
}
