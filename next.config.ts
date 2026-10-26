import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Phones on the LAN open the dev server by IP; Next blocks cross-origin dev assets unless the host is listed.
  allowedDevOrigins: ["192.168.*.*"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
