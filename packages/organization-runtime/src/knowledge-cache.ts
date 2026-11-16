import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { SkillManifest } from "@ericsanchezok/synergy-local-runtime/skill/manifest"
import {
  OrganizationKnowledgeProtocol as Knowledge,
  OrganizationPublicationProtocol as Publication,
} from "@ericsanchezok/synergy-organization-protocol"

export namespace KnowledgeCache {
  const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
  export function id(release: Knowledge.Release, projectID: string) {
    return hash(JSON.stringify([release.orgID, projectID, release.itemID, release.version, release.manifestHash]))
  }
  export function contained(directory: string, candidate: string) {
    const relative = path.relative(directory, candidate)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  }
  export function leaf(release: Knowledge.Release) {
    const value = release.kind === "skill" ? release.skill?.name : "material"
    if (!value) throw new Error("Published Skill metadata is missing")
    return release.kind === "skill" ? SkillManifest.Schema.shape.name.parse(value) : value
  }
  export async function directory(root: string, cacheID: string, release: Knowledge.Release) {
    if (!/^[a-f0-9]{64}$/.test(cacheID)) throw new Error("Knowledge cache identity is invalid")
    return path.join(await fs.realpath(root), "data", "organization-knowledge", "releases", cacheID, leaf(release))
  }
  export async function privateDirectory(root: string, directory: string) {
    const canonicalRoot = await fs.realpath(root)
    const expected = contained(path.resolve(root), path.resolve(directory))
      ? path.resolve(canonicalRoot, path.relative(root, directory))
      : path.resolve(directory)
    if (!contained(canonicalRoot, expected)) throw new Error("Knowledge cache cannot use an external directory")
    let current = canonicalRoot
    for (const segment of path.relative(canonicalRoot, expected).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment)
      await fs.mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
      const stat = await fs.lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Knowledge cache cannot use a symbolic-link directory")
    }
    return expected
  }
  export async function* stream(
    directory: string,
    value: Publication.File,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    signal?.throwIfAborted()
    const file = Publication.File.parse(value)
    const filename = path.resolve(directory, Publication.Path.parse(file.path))
    if (!contained(directory, filename)) throw new Error("Knowledge file escaped its release directory")
    const before = await fs.lstat(filename)
    const canonical = await fs.realpath(filename)
    if (!before.isFile() || before.isSymbolicLink() || canonical !== filename || before.size !== file.bytes)
      throw new Error("A cached knowledge file changed; preserve local edits before retrying")
    const descriptor = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let complete = false
    let failed = false
    try {
      const initial = await descriptor.stat()
      if (initial.dev !== before.dev || initial.ino !== before.ino || initial.size !== file.bytes)
        throw new Error("A cached knowledge file changed during opening")
      const digest = createHash("sha256")
      let bytes = 0
      for (;;) {
        signal?.throwIfAborted()
        const buffer = new Uint8Array(Math.min(128 * 1024, file.bytes - bytes + 1))
        const next = await descriptor.read(buffer, 0, buffer.byteLength, bytes)
        signal?.throwIfAborted()
        if (!next.bytesRead) break
        bytes += next.bytesRead
        if (bytes > file.bytes) throw new Error("A cached knowledge file changed during reading")
        const chunk = buffer.subarray(0, next.bytesRead)
        digest.update(chunk)
        yield chunk
      }
      const final = await descriptor.stat()
      const retained = await fs.lstat(filename)
      if (
        bytes !== file.bytes ||
        digest.digest("hex") !== file.sha256 ||
        final.mtimeMs !== initial.mtimeMs ||
        final.ctimeMs !== initial.ctimeMs ||
        retained.dev !== initial.dev ||
        retained.ino !== initial.ino ||
        (await fs.realpath(filename)) !== filename
      )
        throw new Error("A cached knowledge file changed; preserve local edits before retrying")
      signal?.throwIfAborted()
      complete = true
    } catch (error) {
      failed = true
      throw error
    } finally {
      await descriptor.close()
      if (!complete && !failed && !signal?.aborted) throw new Error("Knowledge file read is incomplete")
    }
  }
  export async function verify(
    directory: string,
    release: Knowledge.Release,
    files: AsyncIterable<Publication.File>,
    signal?: AbortSignal,
  ) {
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(directory)) !== directory)
      throw new Error("Knowledge cache cannot use a symbolic-link directory")
    const manifest = createHash("sha256")
    let count = 0
    let bytes = 0
    let previous = ""
    for await (const file of files) {
      signal?.throwIfAborted()
      if (file.fileID !== hash(file.path) || file.fileID <= previous)
        throw new Error("Knowledge file manifest order or identity changed")
      previous = file.fileID
      for await (const _chunk of stream(directory, file, signal)) {
      }
      manifest.update(Publication.manifestLine(file))
      count++
      bytes += file.bytes
    }
    let physical = 0
    async function visit(directory: string) {
      for await (const entry of await fs.opendir(directory)) {
        signal?.throwIfAborted()
        if (entry.isSymbolicLink()) throw new Error("Knowledge releases cannot contain symbolic links")
        if (entry.isDirectory()) await visit(path.join(directory, entry.name))
        else if (entry.isFile()) physical++
        else throw new Error("Knowledge releases can only contain regular files")
      }
    }
    await visit(directory)
    if (
      count !== release.fileCount ||
      physical !== count ||
      bytes !== release.totalBytes ||
      manifest.digest("hex") !== release.manifestHash
    )
      throw new Error("Knowledge release manifest is incomplete or changed")
  }
}
