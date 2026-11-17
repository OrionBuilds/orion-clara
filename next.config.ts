import type { NextConfig } from "next";
import path from "path";

// This app's parent directory — the common ancestor of clara/ and the sibling shared package
// (../agent-core). Turbopack (Next 16's default for both dev and `next build`) treats any
// module resolved outside its `root` as an external package and falls back to a raw Node
// require(), which can't load un-built .ts source — exactly what broke the old @friday-core
// alias attempt. Widening root to the shared ancestor is Next's documented fix for a workspace
// package that lives as a sibling directory rather than nested under the app.
const workspaceRoot = path.resolve(__dirname, "..");

const nextConfig: NextConfig = {
  // Public hostname(s) allowed to hit the dev server (e.g. through a tunnel), comma-separated.
  allowedDevOrigins: (process.env.CLARA_DEV_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  turbopack: {
    root: workspaceRoot,
  },
  outputFileTracingRoot: workspaceRoot,
  // Local shared package (../agent-core, linked via a "file:" dependency in package.json) — Next
  // transpiles its un-built TS source directly under both Webpack and Turbopack.
  transpilePackages: ["@autom8ionlab/agent-core"],
};

export default nextConfig;
