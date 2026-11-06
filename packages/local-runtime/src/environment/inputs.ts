import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"

export class ExecutionInputs {
  private readonly root: string
  constructor(private readonly options: { directory: string; root?: string; separateUser?: boolean }) {
    this.root = options.root ?? path.join(os.tmpdir(), `synergy-inputs-${hash(options.directory)}`)
  }

  async prepare(raw: ExecutionProtocol.Inputs) {
    const input = ExecutionProtocol.Inputs.parse(raw)
    const files = input.files.toSorted((a, b) => a.name.localeCompare(b.name))
    if (new Set(files.map((file) => file.name)).size !== files.length) throw new Error("Duplicate execution input name")
    let total = 0
    const contents = files.map((file) => {
      const bytes = Buffer.from(file.data, "base64")
      if (bytes.toString("base64") !== file.data) throw new Error("Invalid execution input encoding")
      total += bytes.length
      if (bytes.length > 8 * 1024 * 1024 || total > 64 * 1024 * 1024)
        throw new Error("Execution inputs exceed size limit")
      return { name: file.name, bytes }
    })
    const digest = hash(JSON.stringify(files))
    return this.lock(input.id, async () => {
      const receipt = Bun.file(this.receipt(input.id))
      if (await receipt.exists()) {
        const previous = ExecutionProtocol.PreparedInputs.parse(await receipt.json())
        if (previous.digest !== digest) throw new Error("Execution inputs already have different input")
      }
      const directory = this.directory(input.id)
      await fs.mkdir(directory, { recursive: true, mode: this.options.separateUser ? 0o711 : 0o700 })
      const paths: Record<string, string> = {}
      for (const file of contents) {
        const filename = path.join(directory, file.name)
        try {
          await fs.writeFile(filename, file.bytes, { flag: "wx", mode: this.options.separateUser ? 0o444 : 0o400 })
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
          if (!(await fs.lstat(filename)).isFile() || hash(await fs.readFile(filename)) !== hash(file.bytes))
            throw new Error("Execution input contents changed")
        }
        paths[file.name] = filename
      }
      const prepared = { paths, digest }
      await AtomicFile.writeJsonAtomic(this.receipt(input.id), JSON.stringify(prepared), {
        private: true,
        durable: true,
      })
      return prepared
    })
  }

  async discard(id: string, allowed: () => Promise<void>) {
    return this.lock(id, async () => {
      await allowed()
      await fs.rm(this.directory(id), { recursive: true, force: true })
    })
  }

  admit<T>(id: string, fn: () => Promise<T>) {
    return this.lock(id, fn)
  }

  private lock<T>(id: string, fn: () => Promise<T>) {
    ExecutionProtocol.ID.parse(id)
    return withFileLock({ directory: this.options.directory, key: `inputs-${hash(id)}` }, fn)
  }

  private directory(id: string) {
    return path.join(this.root, hash(id))
  }
  private receipt(id: string) {
    return path.join(this.options.directory, hash(id), "inputs.json")
  }
}

function hash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}
