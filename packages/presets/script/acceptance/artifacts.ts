import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { digest } from "./evidence"

async function fileDigest(file: string) {
  const hash = createHash("sha256")
  const reader = Bun.file(file).stream().getReader()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      hash.update(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  return hash.digest("hex")
}

export async function artifactDigest(input: string) {
  const root = await fs.realpath(input)
  const stat = await fs.lstat(root)
  if (stat.isFile()) return fileDigest(root)
  if (!stat.isDirectory()) throw new Error("Frozen inputs must be files or artifact directories")
  const entries: Array<{ path: string; type: string; executable?: number; sha256?: string; target?: string }> = []
  async function visit(directory: string) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name)
      const relative = path.relative(root, file).split(path.sep).join("/")
      const value = await fs.lstat(file)
      if (value.isSymbolicLink()) {
        const target = await fs.realpath(file)
        if (target !== root && !target.startsWith(root + path.sep))
          throw new Error("Dependency link points outside the frozen artifact")
        entries.push({ path: relative, type: "link", target: await fs.readlink(file) })
      } else if (value.isDirectory()) {
        entries.push({ path: relative, type: "directory" })
        await visit(file)
      } else if (value.isFile()) {
        entries.push({ path: relative, type: "file", executable: value.mode & 0o111, sha256: await fileDigest(file) })
      } else throw new Error("Artifact inventory contains a socket or special file")
    }
  }
  await visit(root)
  return digest(JSON.stringify(entries))
}
