import path from "node:path"
import { z } from "zod"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { RuntimeContext } from "./context"

export namespace HomeOwnership {
  export const Info = z.strictObject({
    schemaVersion: z.literal(1),
    owner: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    identity: z.string().regex(/^[a-f0-9]{64}$/),
  })
  export type Info = z.infer<typeof Info>
  const state = RuntimeContext.state(() => ({ selected: undefined as Info | undefined }))

  export class Error extends globalThis.Error {
    constructor(message: string) {
      super(message)
      this.name = "HomeOwnershipError"
    }
  }
  function filename() {
    return path.join(RuntimeContext.current().host.root, "home-ownership.json")
  }

  export function select(input: Omit<Info, "schemaVersion">) {
    RuntimeContext.assertCompositionOpen("Home owner")
    if (state().selected) throw new Error("Home owner is already selected")
    state().selected = Info.parse({ ...input, schemaVersion: 1 })
  }

  export async function read() {
    const contents = await Bun.file(filename())
      .slice(0, 4097)
      .text()
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
    if (contents === undefined) return undefined
    try {
      if (Buffer.byteLength(contents) > 4096) throw new Error("Home ownership record is too large")
      return Info.parse(JSON.parse(contents))
    } catch {
      throw new Error("Home ownership record is invalid or unsupported")
    }
  }

  export async function assert(options: { required?: boolean } = {}) {
    const current = await read()
    const selected = state().selected
    if (!current) {
      if (selected && options.required) throw new Error("Home owner has not persisted its identity")
      return
    }
    if (!selected || selected.owner !== current.owner || selected.identity !== current.identity)
      throw new Error("Home owner is unavailable or does not match this identity")
    return current
  }

  export async function persist() {
    const selected = state().selected
    if (!selected) throw new Error("Select a Home owner before persisting its identity")
    await withFileLock(
      { directory: path.join(RuntimeContext.current().host.root, "state", ".locks"), key: "home-ownership" },
      async () => {
        if (await assert()) return
        await AtomicFile.writeJsonAtomic(filename(), JSON.stringify(selected) + "\n", { private: true, durable: true })
      },
    )
  }
}
