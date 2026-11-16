import path from "node:path"
import { constants, createReadStream } from "node:fs"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
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
  const Source = z.discriminatedUnion("schemaVersion", [FencedInfo, RestorationInfo])
  export const RetirementInfo = FencedInfo.extend({
    schemaVersion: z.literal(4),
    maintenanceID: z.string().min(1).max(128),
    referenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    physicalHash: z.string().regex(/^[a-f0-9]{64}$/),
    source: Source,
  }).refine(
    (value) => value.owner === value.source.owner && value.identity === value.source.identity,
    "Source retirement must retain its original Home identity",
  )
  export type RetirementInfo = z.infer<typeof RetirementInfo>
  export const Info = z.discriminatedUnion("schemaVersion", [LegacyInfo, FencedInfo, RestorationInfo, RetirementInfo])
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
    async function physicalHash() {
      const info = await fs.lstat(root, { bigint: true })
      const canonical = await fs.realpath(root)
      const after = await fs.lstat(root, { bigint: true })
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        after.dev !== info.dev ||
        after.ino !== info.ino
      )
        throw new Error("Native Home physical directory is invalid or changed")
      return createHash("sha256")
        .update(JSON.stringify([canonical, info.dev.toString(), info.ino.toString()]))
        .digest("hex")
    }

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
          (selected.installationID !== current.installationID || selected.incarnation !== current.incarnation)) ||
        (selected.schemaVersion === 4 &&
          current.schemaVersion === 4 &&
          (selected.maintenanceID !== current.maintenanceID ||
            selected.referenceHash !== current.referenceHash ||
            selected.physicalHash !== current.physicalHash ||
            JSON.stringify(selected.source) !== JSON.stringify(current.source)))
      )
        throw new Error("Home owner format requires its explicit migration")
      if (current.schemaVersion === 4 && current.physicalHash !== (await physicalHash()))
        throw new Error("Retired Home physical identity does not match its original directory")
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
    async function advanceReader(expected: Info, options: { signal?: AbortSignal } = {}) {
      const prior = Source.parse(expected)
      const target = Source.parse(selected)
      if (JSON.stringify({ ...prior, readerContract: target.readerContract }) !== JSON.stringify(target))
        throw new Error("Home reader advancement must retain its original format and identity")
      const physical = await physicalHash()
      await withFileLock(
        { directory: path.join(root, "state", ".locks"), key: "home-ownership", signal: options.signal },
        async () => {
          options.signal?.throwIfAborted()
          if ((await physicalHash()) !== physical) throw new Error("Home reader physical identity changed")
          const before = await fs.lstat(filename, { bigint: true })
          if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4096n)
            throw new Error("Home reader ownership file is invalid or changed")
          const file = await fs.open(filename, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
          try {
            const initial = await file.stat({ bigint: true })
            if (
              !initial.isFile() ||
              initial.nlink !== 1n ||
              initial.dev !== before.dev ||
              initial.ino !== before.ino ||
              initial.size !== before.size ||
              initial.ctimeNs !== before.ctimeNs
            )
              throw new Error("Home reader ownership file changed while opening")
            const verify = async () => {
              options.signal?.throwIfAborted()
              if ((await physicalHash()) !== physical) throw new Error("Home reader physical identity changed")
              const current = await fs.lstat(filename, { bigint: true })
              const retained = await file.stat({ bigint: true })
              if (
                !current.isFile() ||
                current.isSymbolicLink() ||
                current.nlink !== 1n ||
                current.dev !== initial.dev ||
                current.ino !== initial.ino ||
                !retained.isFile() ||
                retained.nlink !== 1n ||
                retained.dev !== initial.dev ||
                retained.ino !== initial.ino ||
                current.size !== retained.size ||
                current.ctimeNs !== retained.ctimeNs
              )
                throw new Error("Home reader requires its original ownership file")
            }
            await verify()
            const bytes = Buffer.alloc(4097)
            const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
            let current: Info
            try {
              if (bytesRead > 4096) throw new Error("Home reader ownership file is too large")
              current = Info.parse(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")))
            } catch {
              throw new Error("Home reader ownership file is invalid or unsupported")
            }
            await verify()
            if (JSON.stringify(current) !== JSON.stringify(prior))
              throw new Error("Home owner changed before reader advancement")
            if (JSON.stringify(current) === JSON.stringify(target)) return
            const encoded = Buffer.from(JSON.stringify(target) + "\n")
            for (let offset = 0; offset < encoded.byteLength;) {
              await verify()
              const { bytesWritten } = await file.write(encoded, offset, encoded.byteLength - offset, offset)
              if (!bytesWritten) throw new Error("Home reader ownership write made no progress")
              offset += bytesWritten
            }
            await verify()
            await file.truncate(encoded.byteLength)
            await file.sync()
            await verify()
            await assert({ required: true })
            await verify()
          } finally {
            await file.close()
          }
        },
      )
    }
    function retirement(expected: z.infer<typeof Source>) {
      const prior = Source.parse(expected)
      if (!selected || selected.schemaVersion !== 4 || JSON.stringify(selected.source) !== JSON.stringify(prior))
        throw new Error("Source retirement requires its original fenced Home identity")
      return { prior, marker: selected, encoded: Buffer.from(JSON.stringify(selected) + "\n") }
    }
    async function withRetirementFile<T>(
      expected: z.infer<typeof Source>,
      writable: boolean,
      action: (input: {
        file: fs.FileHandle
        encoded: Buffer
        status: "source" | "retired" | "incomplete"
      }) => Promise<T>,
    ) {
      const { prior, marker, encoded } = retirement(expected)
      if (marker.physicalHash !== (await physicalHash()))
        throw new Error("Source Home physical identity changed before permanent retirement")
      const before = await fs.lstat(filename, { bigint: true })
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4096n)
        throw new Error("Source Home ownership is invalid or changed")
      const file = await fs.open(
        filename,
        (writable ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0),
      )
      try {
        const info = await file.stat({ bigint: true })
        if (
          !info.isFile() ||
          info.nlink !== 1n ||
          info.dev !== before.dev ||
          info.ino !== before.ino ||
          info.size !== before.size ||
          marker.physicalHash !== (await physicalHash())
        )
          throw new Error("Source Home physical identity changed before permanent retirement")
        const bytes = Buffer.alloc(4097)
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
        const raw = bytes.subarray(0, bytesRead)
        const after = await file.stat({ bigint: true })
        if (after.size !== BigInt(bytesRead) || after.size !== info.size || after.nlink !== 1n)
          throw new Error("Source Home ownership changed while reading")
        let value: unknown
        try {
          value = Info.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)))
        } catch {}
        const status =
          JSON.stringify(value) === JSON.stringify(prior)
            ? "source"
            : JSON.stringify(value) === JSON.stringify(marker)
              ? "retired"
              : raw.length < encoded.length && raw.equals(encoded.subarray(0, raw.length))
                ? "incomplete"
                : undefined
        if (!status) throw new Error("Source Home owner changed before permanent retirement")
        return await action({ file, encoded, status })
      } finally {
        await file.close()
      }
    }
    async function inspectRetirement(expected: z.infer<typeof Source>) {
      return withRetirementFile(expected, false, async ({ status }) => status)
    }
    async function retire(expected: z.infer<typeof Source>) {
      retirement(expected)
      await withFileLock({ directory: path.join(root, "state", ".locks"), key: "home-ownership" }, () =>
        withRetirementFile(expected, true, async ({ file, encoded, status }) => {
          if (status !== "retired") {
            // A pathname rename could publish into a replaced Home; retain this original inode through the fence.
            await file.truncate(0)
            await file.sync()
            let offset = 0
            while (offset < encoded.length) {
              const { bytesWritten } = await file.write(encoded, offset, encoded.length - offset, offset)
              if (!bytesWritten) throw new Error("Source Home retirement made no write progress")
              offset += bytesWritten
            }
          }
          await file.sync()
          await assert({ required: true })
        }),
      )
    }
    return { read, assert, persist, upgrade, advanceReader, retire, inspectRetirement, physicalHash }
  }
}
