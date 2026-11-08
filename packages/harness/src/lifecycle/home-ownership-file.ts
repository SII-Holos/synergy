import path from "node:path"
import { createReadStream } from "node:fs"
import { z } from "zod"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { assertIsolatedTestHome } from "../global/test-home-guard.js"

export namespace HomeOwnershipFile {
  export const Info = z.strictObject({
    schemaVersion: z.literal(1),
    owner: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    identity: z.string().regex(/^[a-f0-9]{64}$/),
  })
  export type Info = z.infer<typeof Info>

  export class Error extends globalThis.Error {
    constructor(message: string) {
      super(message)
      this.name = "HomeOwnershipError"
    }
  }

  export function open(input: { root: string; selected?: Info; env: Readonly<Record<string, string | undefined>> }) {
    if (!path.isAbsolute(input.root)) throw new Error("Home ownership root must be absolute")
    const root = path.resolve(input.root)
    const entry = (globalThis as { Bun?: { main: string } }).Bun?.main
    assertIsolatedTestHome(root, entry, process.argv, input.env)
    const selected = input.selected ? Info.parse(input.selected) : undefined
    const filename = path.join(root, "home-ownership.json")

    async function read() {
      const chunks: Buffer[] = []
      try {
        for await (const chunk of createReadStream(filename, { end: 4096 })) chunks.push(chunk)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      }
      const contents = Buffer.concat(chunks).toString("utf8")
      try {
        if (Buffer.byteLength(contents) > 4096) throw new Error("Home ownership record is too large")
        return Info.parse(JSON.parse(contents))
      } catch {
        throw new Error("Home ownership record is invalid or unsupported")
      }
    }

    async function assert(options: { required?: boolean } = {}) {
      const current = await read()
      if (!current) {
        if (selected && options.required) throw new Error("Home owner has not persisted its identity")
        return
      }
      if (!selected || selected.owner !== current.owner || selected.identity !== current.identity)
        throw new Error("Home owner is unavailable or does not match this identity")
      return current
    }

    async function persist() {
      if (!selected) throw new Error("Select a Home owner before persisting its identity")
      await withFileLock({ directory: path.join(root, "state", ".locks"), key: "home-ownership" }, async () => {
        if (await assert()) return
        await AtomicFile.writeJsonAtomic(filename, JSON.stringify(selected) + "\n", { private: true, durable: true })
      })
    }
    return { read, assert, persist }
  }
}
