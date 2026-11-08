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

export async function readOrganizationConfiguration(home: string) {
  if (!path.isAbsolute(home)) throw new Error("Organization Home must be absolute")
  const filename = path.join(home, ".synergy", "config", "synergy.d", ORGANIZATION_CONFIG_FILENAME)
  const invalid = (reason: z.infer<typeof OrganizationConfigurationError.Schema>["data"]["reason"]) =>
    new OrganizationConfigurationError({ path: filename, reason })
  const file = await fs
    .open(filename, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw invalid("read_failed")
    })
  if (!file) return OrganizationSettings.parse({})
  try {
    const initial = await file.stat()
    if (!initial.isFile()) throw invalid("not_regular")
    if (initial.size > 4 * 1024 * 1024) throw invalid("too_large")
    const bytes = Buffer.alloc(initial.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const final = await file.stat()
    if (
      offset !== initial.size ||
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs
    )
      throw invalid("changed")
    const errors: ParseError[] = []
    const input: unknown = parse(bytes.subarray(0, offset).toString("utf8"), errors, { allowTrailingComma: true })
    if (errors.length) throw invalid("invalid_json")
    const result = z.strictObject({ $schema: z.string().optional(), ...ConfigShape }).safeParse(input)
    if (!result.success) throw invalid("invalid_settings")
    return result.data.organization ?? OrganizationSettings.parse({})
  } finally {
    await file.close()
  }
}
