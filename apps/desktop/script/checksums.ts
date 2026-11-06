#!/usr/bin/env bun
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { desktopChecksumsName } from "../src/release-assets.js"

const releaseDir = path.resolve(process.argv[2] ?? "release")
const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as { version: string }
const version = process.env.SYNERGY_VERSION?.trim() || packageJson.version
const entries = await fs.readdir(releaseDir, { withFileTypes: true })
const files = entries
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((name) => name !== desktopChecksumsName(version))
  .sort()

const lines: string[] = []
for (const name of files) {
  const filepath = path.join(releaseDir, name)
  const data = await fs.readFile(filepath)
  lines.push(`${createHash("sha256").update(data).digest("hex")}  ${name}`)
}

await fs.writeFile(path.join(releaseDir, desktopChecksumsName(version)), `${lines.join("\n")}\n`)
