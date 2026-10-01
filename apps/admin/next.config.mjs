import path from "node:path";

// One .env at the repo root feeds both apps (values already in the environment win).
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"));
} catch {}

const noFrame = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@chatbase/core", "@chatbase/ui"],
  // Loaded by Node as-is instead of bundled: unpdf (PDF reading) uses import.meta in a way webpack warns about.
  serverExternalPackages: ["unpdf"],
  async headers() {
    return [{ source: "/:path*", headers: noFrame }];
  },
};
export default nextConfig;
