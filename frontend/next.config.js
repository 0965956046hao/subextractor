/** @type {import('next').NextConfig} */
const isProduction = process.env.NODE_ENV === "production";
const nextConfig = {
  // `standalone` is only valid for production builds (`next build` / `next start`).
  // Leaving it on in `next dev` crashes the App Router with
  // "Cannot read properties of undefined (reading 'entryCSSFiles')".
  output: isProduction ? "standalone" : undefined,
  experimental: {
    serverComponentsExternalPackages: ["puppeteer-core"],
    // Match the upload client's 120-minute timeout. The default proxy idle
    // timeout is only 30s and can reset uploads while the OCR backend is busy.
    proxyTimeout: 120 * 60 * 1000,
  },
  async rewrites() {
    return {
      // afterFiles => App Router route handlers (e.g. app/api/video-download/*)
      // take precedence; everything else under /api/* proxies to the backend.
      afterFiles: [
        {
          source: "/api/:path*",
          destination: `${process.env.BACKEND_URL || "http://localhost:8000"}/api/:path*`,
        },
      ],
    };
  },
};

module.exports = nextConfig;
