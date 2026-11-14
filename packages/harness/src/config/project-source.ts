import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import type { Scope } from "../scope"
import { isPathContained } from "../util/path-contain"
import { ConfigDomain } from "./domain"

export namespace ProjectConfig {
  export const InvalidError = NamedError.create(
    "ProjectConfigInvalidError",
    z.object({
      path: z.string(),
      reason: z.enum(["outside_project", "not_regular", "changed", "too_large", "invalid_json", "read_failed"]),
    }),
  )
  const maxBytes = 4 * 1024 * 1024

  async function read(root: string, filename: string) {
    const invalid = (reason: z.infer<typeof InvalidError.Schema>["data"]["reason"]) =>
      new InvalidError({ path: filename, reason })
    if (!isPathContained(root, filename)) throw invalid("outside_project")
    const handle = await fs
      .open(
        filename,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
      )
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined
        throw new InvalidError({ path: filename, reason: "read_failed" }, { cause: error })
      })
    if (!handle) return {}
    try {
      const [opened, current] = await Promise.all([handle.stat(), fs.stat(filename)])
      if (!opened.isFile()) throw invalid("not_regular")
      if (opened.dev !== current.dev || opened.ino !== current.ino) throw invalid("changed")
      if (!isPathContained(root, filename)) throw invalid("outside_project")
      if (opened.size > maxBytes) throw invalid("too_large")
      const bytes = Buffer.alloc(opened.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      const final = await handle.stat()
      if (
        offset !== opened.size ||
        final.size !== opened.size ||
        final.mtimeMs !== opened.mtimeMs ||
        final.ctimeMs !== opened.ctimeMs
      )
        throw invalid("changed")
      const errors: ParseError[] = []
      const value: unknown = parse(bytes.subarray(0, offset).toString("utf8"), errors, { allowTrailingComma: true })
      if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) throw invalid("invalid_json")
      return value as Record<string, unknown>
    } finally {
      await handle.close()
    }
  }

  export async function fields(scope: Scope, keys: readonly string[]) {
    if (scope.type !== "project" || !scope.local || !keys.length) return {}
    const root = await fs.realpath(scope.local.directory)
    const domains = new Map<string, { filename: string; keys: string[] }>()
    for (const key of new Set(keys)) {
      const domain = ConfigDomain.domainForKey(key)
      if (!domain || domain.globalOnly)
        throw new Error("Project configuration selection requires registered project fields")
      const selected = domains.get(domain.id) ?? {
        filename: ConfigDomain.filepath(domain.id, path.join(root, ".synergy")),
        keys: [],
      }
      selected.keys.push(key)
      domains.set(domain.id, selected)
    }
    const result: Record<string, unknown> = {}
    for (const domain of domains.values()) {
      const value = await read(root, domain.filename)
      for (const key of domain.keys) if (Object.hasOwn(value, key)) result[key] = value[key]
    }
    return result
  }
}
