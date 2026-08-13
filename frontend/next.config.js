/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["puppeteer-core"],
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
