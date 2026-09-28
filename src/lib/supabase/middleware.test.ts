import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

const getUserMock = vi.fn();
const createServerClientMock = vi.fn(() => ({
  auth: { getUser: getUserMock },
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: createServerClientMock,
}));

const { updateSession, hasSupabaseAuthCookie } = await import("./middleware");
const { config } = await import("@/proxy");

beforeEach(() => {
  vi.clearAllMocks();
});

function request(cookie?: string) {
  return new NextRequest("https://www.govroll.com/api/votes/1", {
    headers: cookie ? { cookie } : {},
  });
}

describe("updateSession", () => {
  it("skips the Supabase client entirely for anonymous requests", async () => {
    const res = await updateSession(request("theme=dark"));
    expect(res.status).toBe(200);
    expect(createServerClientMock).not.toHaveBeenCalled();
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("refreshes the session when an auth cookie is present", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    await updateSession(request("sb-xgwtswbnkwbiqfejtczy-auth-token.0=abc"));
    expect(createServerClientMock).toHaveBeenCalledTimes(1);
    expect(getUserMock).toHaveBeenCalledTimes(1);
  });

  it("recognizes plain and chunked Supabase auth cookies only", () => {
    expect(hasSupabaseAuthCookie(request("sb-ref-auth-token=x"))).toBe(true);
    expect(hasSupabaseAuthCookie(request("sb-ref-auth-token.1=x"))).toBe(true);
    expect(hasSupabaseAuthCookie(request("sb-other=x; a=b"))).toBe(false);
    expect(hasSupabaseAuthCookie(request())).toBe(false);
  });
});

describe("proxy matcher", () => {
  const matches = (path: string) =>
    unstable_doesMiddlewareMatch({
      config,
      url: `https://www.govroll.com${path}`,
    });

  it.each([
    "/api/votes/123",
    "/api/comments",
    "/api/account/conversations",
    "/api/ai/chat",
    "/api/user/preferences",
  ])("runs on session-reading API route %s", (path) => {
    expect(matches(path)).toBe(true);
  });

  it.each([
    "/",
    "/bills",
    "/bills/119/hr/248-baby-changing-on-board-act",
    "/bills/119/hr/248-baby-changing-on-board-act/read",
    "/bills/119/hr/248-baby-changing-on-board-act/opengraph-image-12b732",
    "/representatives/nancy-pelosi",
    "/sitemap.xml",
    "/sitemaps/bills-119-1.xml",
    "/robots.txt",
    "/api/cron/fetch-votes",
    "/api/health",
    "/api/photos/P000197",
    "/api/errors/report",
    "/api/stripe/webhook",
  ])("skips %s", (path) => {
    expect(matches(path)).toBe(false);
  });
});
