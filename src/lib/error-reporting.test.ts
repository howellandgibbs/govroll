/**
 * Pins the alert-email contract. The ingest-health watchdog's multi-line
 * breach summary used to go out verbatim as the subject; Resend rejected it
 * and, with no res.ok check, the stall alarm paged into nothing for days.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { alertSubject, reportError } from "./error-reporting";

describe("alertSubject", () => {
  it("collapses a multi-line message onto one header line", () => {
    const subject = alertSubject(
      "Ingest pipeline(s) stalled:\n- fetch-votes: cursor hasn't advanced\r\n- fetch-bills: x",
    );
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toBe(
      "[Govroll] Ingest pipeline(s) stalled: - fetch-votes: cursor hasn't advanced - fetch-bills: x",
    );
  });

  it("caps the message at 100 characters", () => {
    expect(alertSubject("a".repeat(300))).toBe(`[Govroll] ${"a".repeat(100)}`);
  });
});

describe("reportError", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("ALERT_EMAIL", "alerts@example.test");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("sends a single-line subject and keeps the full message in the body", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await reportError(new Error("stalled:\n- fetch-votes: 83.7h"));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.subject).toBe("[Govroll] stalled: - fetch-votes: 83.7h");
    expect(body.text).toContain("stalled:\n- fetch-votes: 83.7h");
  });

  it("logs a rejected send instead of swallowing it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue(
      new Response('{"name":"validation_error"}', { status: 422 }),
    );
    await reportError(new Error("unique message for the 422 path"));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("HTTP 422"));
    errorSpy.mockRestore();
  });
});
