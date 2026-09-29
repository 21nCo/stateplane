// Do not acknowledge a projection job before its durable implementation exists.
// Cloudflare retries failures and then delivers to the configured DLQ.
export default {
  queue(): Promise<void> {
    return Promise.reject(new Error('Projection worker is not active'));
  }
} satisfies ExportedHandler;
