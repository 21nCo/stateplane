// A cell is reachable only through a service binding until routing and
// authorization are implemented in STA-5. Its database and R2 bindings are
// intentionally unused by this transport scaffold.
export default {
  fetch(): Response {
    return new Response('Cell unavailable', { status: 503 });
  }
} satisfies ExportedHandler;
