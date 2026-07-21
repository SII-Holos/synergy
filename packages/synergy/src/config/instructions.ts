import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "../global"
import { Lock } from "../util/lock"

export namespace ConfigInstructions {
  export const PRIMARY_FILENAME = "AGENTS.md"
  export const OVERRIDE_FILENAME = "AGENTS.override.md"
  export const MAX_BYTES = 32 * 1024

  export const Info = z
    .object({
      content: z.string(),
      source: z.enum(["override", "primary", "empty"]),
      sourceFilename: z.enum([OVERRIDE_FILENAME, PRIMARY_FILENAME]).nullable(),
      editableFilename: z.literal(OVERRIDE_FILENAME),
      hasOverride: z.boolean(),
      maxBytes: z.number().int().positive(),
    })
    .meta({ ref: "ConfigInstructionsInfo" })

  export const UpdateInput = z
    .object({
      content: z.string().superRefine((content, context) => {
        if (Buffer.byteLength(content, "utf8") <= MAX_BYTES) return
        context.addIssue({
          code: "custom",
          message: `Custom instructions must not exceed ${MAX_BYTES} bytes.`,
        })
      }),
    })
    .meta({ ref: "ConfigInstructionsUpdateInput" })

  function filepath(filename: typeof PRIMARY_FILENAME | typeof OVERRIDE_FILENAME) {
    return path.join(Global.Path.config, filename)
  }

  async function readFile(filename: typeof PRIMARY_FILENAME | typeof OVERRIDE_FILENAME) {
    return fs.readFile(filepath(filename), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
  }

  export async function get(): Promise<z.infer<typeof Info>> {
    const override = await readFile(OVERRIDE_FILENAME)
    if (override !== undefined) {
      return {
        content: override,
        source: "override",
        sourceFilename: OVERRIDE_FILENAME,
        editableFilename: OVERRIDE_FILENAME,
        hasOverride: true,
        maxBytes: MAX_BYTES,
      }
    }

    const primary = await readFile(PRIMARY_FILENAME)
    if (primary !== undefined) {
      return {
        content: primary,
        source: "primary",
        sourceFilename: PRIMARY_FILENAME,
        editableFilename: OVERRIDE_FILENAME,
        hasOverride: false,
        maxBytes: MAX_BYTES,
      }
    }

    return {
      content: "",
      source: "empty",
      sourceFilename: null,
      editableFilename: OVERRIDE_FILENAME,
      hasOverride: false,
      maxBytes: MAX_BYTES,
    }
  }

  export async function update(content: string) {
    if (!content.trim()) return reset()

    const target = filepath(OVERRIDE_FILENAME)
    using _ = await Lock.write(target)
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temporary = path.join(
      path.dirname(target),
      `.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    )
    try {
      await Bun.write(temporary, content)
      await fs.rename(temporary, target)
    } finally {
      await fs.rm(temporary, { force: true })
    }
    return get()
  }

  export async function reset() {
    const target = filepath(OVERRIDE_FILENAME)
    using _ = await Lock.write(target)
    await fs.rm(target, { force: true })
    return get()
  }
}
