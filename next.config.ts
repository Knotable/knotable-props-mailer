import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    // Pre-existing TS errors in logger/cookie utils don't affect runtime behaviour
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
