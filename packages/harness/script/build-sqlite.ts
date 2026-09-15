import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"

// SQLite's WAL reset fix: https://www.sqlite.org/wal.html#walreset
const SOURCE = "https://www.sqlite.org/2026/sqlite-amalgamation-3510300.zip"
const SHA256 = "acb1e6f5d832484bf6d32b681e858c38add8b2acdfd42ac5df24b8afb46552b4"
const directory = path.resolve(import.meta.dirname, "../.artifacts/sqlite")
const filename = path.join(directory, "libsqlite3.dylib")

export async function buildSqlite() {
  if (await Bun.file(filename).exists()) {
    const receipt = await Bun.file(path.join(directory, "receipt.json")).json()
    const hash = createHash("sha256")
      .update(await Bun.file(filename).bytes())
      .digest("hex")
    if (receipt.source === SHA256 && receipt.binary === hash) return filename
    throw new Error("SQLite build receipt does not match the staged engine")
  }
  if (process.platform !== "darwin")
    throw new Error("Build the universal SQLite engine on macOS or download the sqlite-assets-darwin CI artifact")
  await fs.mkdir(directory, { recursive: true })
  const stage = await fs.mkdtemp(path.join(directory, ".build-"))
  try {
    const response = await fetch(SOURCE)
    if (!response.ok) throw new Error(`SQLite source download failed: ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (createHash("sha256").update(bytes).digest("hex") !== SHA256) throw new Error("SQLite source checksum mismatch")
    const archive = path.join(stage, "source.zip")
    await Bun.write(archive, bytes)
    await run(["unzip", "-q", archive, "-d", stage])
    const source = path.join(stage, "sqlite-amalgamation-3510300/sqlite3.c")
    const output = path.join(stage, "libsqlite3.dylib")
    await run([
      "clang",
      "-O2",
      "-dynamiclib",
      "-arch",
      "arm64",
      "-arch",
      "x86_64",
      "-mmacosx-version-min=11.0",
      "-DSQLITE_THREADSAFE=1",
      "-DSQLITE_ENABLE_FTS5",
      "-DSQLITE_ENABLE_RTREE",
      "-DSQLITE_ENABLE_COLUMN_METADATA",
      "-DSQLITE_DQS=0",
      "-install_name",
      "@rpath/libsqlite3.dylib",
      source,
      "-o",
      output,
    ])
    await fs.rename(output, filename)
    const binary = createHash("sha256")
      .update(await Bun.file(filename).bytes())
      .digest("hex")
    await Bun.write(path.join(directory, "receipt.json"), JSON.stringify({ source: SHA256, binary, version: "3.51.3" }))
    return filename
  } finally {
    await fs.rm(stage, { recursive: true, force: true })
  }
}

async function run(command: string[]) {
  const process = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" })
  if (await process.exited) throw new Error(`SQLite build failed: ${command[0]}`)
}

if (import.meta.main) console.log(await buildSqlite())
