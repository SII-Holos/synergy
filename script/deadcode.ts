#!/usr/bin/env bun
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const run = Bun.spawn(
  [
    process.execPath,
    "--bun",
    path.join(root, "node_modules/knip/bin/knip.js"),
    "--directory",
    root,
    "--include",
    "dependencies,unlisted,binaries,unresolved,catalog",
    ...process.argv.slice(2),
  ],
  {
    // Jiti discovers tsconfig from the parent of its cwd-based loader path.
    cwd: import.meta.dir,
    stdout: "inherit",
    stderr: "inherit",
  },
)
process.exit(await run.exited)
