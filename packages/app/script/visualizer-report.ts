#!/usr/bin/env bun

const output = process.env.SYNERGY_BUNDLE_REPORT ?? "dist/performance/bundle-visualizer.html"
const mode = process.env.SYNERGY_BUNDLE_REPORT_MODE ?? "treemap"

console.log(
  [
    "Synergy app bundle visualizer report",
    "",
    "This opt-in helper keeps rollup-plugin-visualizer out of the runtime dependency graph.",
    "Install it only when generating a local report:",
    "  bun add -d rollup-plugin-visualizer --cwd packages/app",
    "",
    "Then run:",
    `  SYNERGY_BUNDLE_VISUALIZER=1 SYNERGY_BUNDLE_REPORT=${output} SYNERGY_BUNDLE_REPORT_MODE=${mode} bun run --cwd packages/app build`,
    "",
    "The app Vite config reads those environment variables and writes the static report during build.",
  ].join("\n"),
)
