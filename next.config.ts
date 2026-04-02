import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // output: "standalone" is only needed for Docker — omitted for Vercel
  serverExternalPackages: [
    "pdfjs-dist",         // heavy PDF parser — keep server-side only
    "@napi-rs/canvas",    // native canvas — cannot be bundled for browser
  ],
};

export default nextConfig;
