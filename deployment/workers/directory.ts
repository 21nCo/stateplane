// STA-5 owns the placement lookup and routing assertion. This private Worker
// deliberately exposes no SQL or directory record API before that boundary exists.
export default {
  fetch(): Response {
    return new Response('Directory unavailable', { status: 503 });
  }
} satisfies ExportedHandler;
