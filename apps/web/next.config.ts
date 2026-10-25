import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@tpw/shared"],
  serverExternalPackages: ["@react-pdf/renderer"],
};

export default config;
