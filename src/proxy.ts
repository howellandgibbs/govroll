import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Session refresh only where the Supabase session is read on the server:
     * the API routes (getAuthenticatedUser → auth.getUser()). No page or
     * layout reads auth server-side — the UI authenticates client-side — so
     * page views, the sitemap, robots.txt and OG images skip the proxy. On
     * Vercel every matched request is an extra function invocation billed
     * against the Hobby plan's Active CPU, and nearly all page traffic is
     * crawlers.
     *
     * Excluded API routes never read the session: cron (bearer secret),
     * health, photos, client error reports, and the Stripe webhook.
     */
    "/api/((?!cron/|health|photos/|errors/|stripe/webhook).*)",
  ],
};
