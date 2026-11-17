/**
 * True when the server runs on Google Cloud Run (Cloud Run sets `K_SERVICE`).
 *
 * With Cloud Run's request-based billing, an instance gets CPU only while a
 * request is in flight; once the response is sent the CPU is throttled to
 * almost nothing. Work handed to `after()` can then stall for minutes or never
 * finish, so code paths that rely on post-response work must either finish
 * inside the request or leave the work to a cron.
 */
export function cpuThrottledAfterResponse(): boolean {
  return Boolean(process.env.K_SERVICE);
}
