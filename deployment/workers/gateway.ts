export default {
  fetch(request: Request): Response {
    if (new URL(request.url).pathname === '/health') {
      return Response.json({ service: 'stateplane-mcp-gateway', status: 'scaffold' });
    }
    return new Response('Service unavailable', { status: 503 });
  }
} satisfies ExportedHandler;
