import path from "node:path"
import { createReadStream } from "node:fs"
import { z } from "zod"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { assertIsolatedTestHome } from "../global/test-home-guard.js"

export namespace HomeOwnershipFile {
  const fields = {
    owner: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    identity: z.string().regex(/^[a-f0-9]{64}$/),
  }
  export const LegacyInfo = z.strictObject({
    schemaVersion: z.literal(1),
    ...fields,
  })
  export const FencedInfo = z.strictObject({
    schemaVersion: z.literal(2),
    ...fields,
    readerContract: z.string().regex(/^[a-z][a-z0-9-]{0,127}$/),
  })
  export const RestorationInfo = FencedInfo.extend({
    schemaVersion: z.literal(3),
    installationID: z.uuid(),
    incarnation: z.uuid(),
  })
  export type RestorationInfo = z.infer<typeof RestorationInfo>
  export const Info = z.discriminatedUnion("schemaVersion", [LegacyInfo, FencedInfo, RestorationInfo])
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
      if (
        selected.schemaVersion !== current.schemaVersion ||
        (selected.schemaVersion !== 1 &&
          current.schemaVersion !== 1 &&
          selected.readerContract !== current.readerContract) ||
        (selected.schemaVersion === 3 &&
          current.schemaVersion === 3 &&
          (selected.installationID !== current.installationID || selected.incarnation !== current.incarnation))
      )
        throw new Error("Home owner format requires its explicit migration")
      return current
    }

    async function persist(options: { signal?: AbortSignal } = {}) {
      if (!selected) throw new Error("Select a Home owner before persisting its identity")
      await withFileLock(
        { directory: path.join(root, "state", ".locks"), key: "home-ownership", signal: options.signal },
        async () => {
          if (await assert()) return
          options.signal?.throwIfAborted()
          await AtomicFile.writeJsonAtomic(filename, JSON.stringify(selected) + "\n", { private: true, durable: true })
        },
      )
    }
    async function upgrade(expected: Info, options: { signal?: AbortSignal } = {}) {
      const prior = LegacyInfo.parse(expected)
      if (
        !selected ||
        selected.schemaVersion !== 2 ||
        selected.owner !== prior.owner ||
        selected.identity !== prior.identity
      )
        throw new Error("Home owner upgrade must retain its selected identity")
      await withFileLock(
        { directory: path.join(root, "state", ".locks"), key: "home-ownership", signal: options.signal },
        async () => {
          const current = await read()
          options.signal?.throwIfAborted()
          if (JSON.stringify(current) === JSON.stringify(selected)) return
          if (JSON.stringify(current) !== JSON.stringify(prior))
            throw new Error("Home owner changed before its upgrade")
          await AtomicFile.writeJsonAtomic(filename, JSON.stringify(selected) + "\n", { private: true, durable: true })
        },
      )
    }
    return { read, assert, persist, upgrade }
  }
}
