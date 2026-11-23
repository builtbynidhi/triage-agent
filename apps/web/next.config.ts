import type { NextConfig } from "next";

/**
 * Two ways to run this app, chosen by environment (lib/data.ts):
 *   - snapshot (default): reads data/snapshot.json, a read-only copy of real runs. This is what is
 *     deployed to Vercel, which cannot load the SQLite native code the live system uses.
 *   - live: set TRIAGE_API_URL and TRIAGE_API_TOKEN and it reads the Express API instead.
 */
const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default config;
