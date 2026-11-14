import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { ConfigShape, ORGANIZATION_CONFIG_FILENAME, OrganizationSettings } from "./config-schema"

export const OrganizationConfigurationError = NamedError.create(
  "OrganizationConfigurationError",
  z.object({
    path: z.string(),
    reason: z.enum(["read_failed", "not_regular", "too_large", "changed", "invalid_json", "invalid_settings"]),
  }),
)

export function parseOrganizationConfiguration(bytes: Uint8Array, filename: string) {
  const invalid = (reason: z.infer<typeof OrganizationConfigurationError.Schema>["data"]["reason"]) =>
    new OrganizationConfigurationError({ path: filename, reason })
  if (bytes.byteLength > 4 * 1024 * 1024) throw invalid("too_large")
  const errors: ParseError[] = []
  const input: unknown = parse(Buffer.from(bytes).toString("utf8"), errors, { allowTrailingComma: true })
  if (errors.length) throw invalid("invalid_json")
  const result = z.strictObject({ $schema: z.string().optional(), ...ConfigShape }).safeParse(input)
  if (!result.success) throw invalid("invalid_settings")
  return result.data.organization ?? OrganizationSettings.parse({})
}

export async function readOrganizationConfiguration(home: string) {
  return (await readOrganizationConfigurationSnapshot(home)).settings
}

export async function readOrganizationConfigurationSnapshot(home: string, options: { signal?: AbortSignal } = {}) {
  const parents: { directory: string; device?: number; inode?: number }[] = []
  const signal = options.signal
  signal?.throwIfAborted()
  if (!path.isAbsolute(home)) throw new Error("Organization Home must be absolute")
  const filename = path.join(home, ".synergy", "config", "synergy.d", ORGANIZATION_CONFIG_FILENAME)
  const invalid = (reason: z.infer<typeof OrganizationConfigurationError.Schema>["data"]["reason"]) =>
    new OrganizationConfigurationError({ path: filename, reason })
  for (const directory of [
    home,
    path.join(home, ".synergy"),
    path.join(home, ".synergy", "config"),
    path.dirname(filename),
  ]) {
    const info = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw invalid("read_failed")
    })
    signal?.throwIfAborted()
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw invalid("not_regular")
    parents.push({ directory, device: info?.dev, inode: info?.ino })
  }
  const before = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw invalid("read_failed")
  })
  signal?.throwIfAborted()
  if (before?.isSymbolicLink()) throw invalid("not_regular")
  const file = await fs
    .open(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (process.platform === "win32" ? 0 : constants.O_NONBLOCK),
    )
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && !before) return undefined
      throw invalid("read_failed")
    })
  if (!file) {
    signal?.throwIfAborted()
    return { present: false, settings: OrganizationSettings.parse({}), bytes: new Uint8Array() }
  }
  try {
    signal?.throwIfAborted()
    const initial = await file.stat()
    if (!initial.isFile()) throw invalid("not_regular")
    if (!before || before.dev !== initial.dev || before.ino !== initial.ino) throw invalid("changed")
    if (initial.size > 4 * 1024 * 1024) throw invalid("too_large")
    const bytes = Buffer.alloc(initial.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      signal?.throwIfAborted()
      if (!bytesRead) break
      offset += bytesRead
    }
    const final = await file.stat()
    for (const parent of parents) {
      const current = await fs.lstat(parent.directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw invalid("read_failed")
      })
      signal?.throwIfAborted()
      if (current?.isSymbolicLink() || current?.dev !== parent.device || current?.ino !== parent.inode)
        throw invalid("changed")
    }
    const retained = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw invalid("read_failed")
    })
    signal?.throwIfAborted()
    if (
      !retained ||
      retained.isSymbolicLink() ||
      retained.dev !== initial.dev ||
      retained.ino !== initial.ino ||
      offset !== initial.size ||
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs
    )
      throw invalid("changed")
    const contents = bytes.subarray(0, offset)
    return { present: true, settings: parseOrganizationConfiguration(contents, filename), bytes: contents }
  } finally {
    await file.close()
  }
}
