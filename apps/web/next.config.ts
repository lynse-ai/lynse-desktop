import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@lynse/core", "@lynse/ui", "@lynse/views"],
};

export default nextConfig;
