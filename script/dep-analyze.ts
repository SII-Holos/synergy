#!/usr/bin/env bun
import path from "node:path"
import { validateWorkspaces } from "./workspace-dependencies"

const root = path.resolve(import.meta.dir, "..")
const result = validateWorkspaces(root)
for (const [owner, dependencies] of Object.entries(result.graph)) console.log(`${owner}: ${dependencies.join(", ")}`)
for (const failure of result.failures) console.error(failure)
console.log(`${result.packages.length} workspaces; ${result.failures.length} dependency violations`)
if (process.argv.includes("--snapshot"))
  await Bun.write(path.join(root, ".deps-snapshot.json"), JSON.stringify(result.graph, null, 2) + "\n")
if (result.failures.length) process.exitCode = 1
