import path from "node:path";

// One .env at the repo root feeds every app (values already in the environment win).
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"));
} catch {}

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};
export default nextConfig;
