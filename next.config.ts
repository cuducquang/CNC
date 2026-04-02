import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // "standalone" is set via NEXT_OUTPUT env var in Dockerfile.web; omitted for Vercel
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" } : {}),
  serverExternalPackages: [
    "pdfjs-dist",         // heavy PDF parser — keep server-side only
    "@napi-rs/canvas",    // native canvas — cannot be bundled for browser
  ],
};

export default nextConfig;
