import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig: NextConfig = {
  // Self-hosted on Google Cloud Run (see Dockerfile): emit a minimal server.js
  // plus only the node_modules it needs, so the image stays small.
  output: "standalone",
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "bioguide.congress.gov",
        pathname: "/bioguide/photo/**",
      },
    ],
  },
  // Vercel's domain settings used to send the apex to www; on Cloud Run both
  // hostnames reach this server, so the app does it.
  redirects: async () => [
    {
      source: "/:path*",
      has: [{ type: "host", value: "govroll.com" }],
      destination: "https://www.govroll.com/:path*",
      permanent: true,
    },
  ],
  headers: async () => [
    {
      source: "/:path*",
      headers: securityHeaders,
    },
  ],
};

export default nextConfig;
