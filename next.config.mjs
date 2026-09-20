/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async headers() {
    const noFrame = [
      { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ];
    return [
      // The embeddable chat page MUST be frameable from customers' websites.
      { source: "/embed/:id", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors *" }] },
      { source: "/widget.js", headers: [{ key: "Cache-Control", value: "public, max-age=3600" }] },
      // Everything else must not be framed (clickjacking protection).
      { source: "/", headers: noFrame },
      { source: "/login", headers: noFrame },
      { source: "/signup", headers: noFrame },
      { source: "/dashboard/:path*", headers: noFrame },
    ];
  },
};
export default nextConfig;
