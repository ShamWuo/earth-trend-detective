import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  outputFileTracingIncludes: {
    "/api/**/*": ["./ml/weights/**/*"],
  },
  outputFileTracingExcludes: {
    "/*": [
      "./.data/**/*",
      "./.etg-cache/**/*",
      "./.blind-export/**/*",
      "./notebooks/**/*",
      "./deliverables/**/*",
    ],
  },
};

export default nextConfig;
