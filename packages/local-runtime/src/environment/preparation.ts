import { createHash } from "node:crypto"
import path from "node:path"
import fs from "node:fs/promises"
import { z } from "zod"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { EnvironmentSchema } from "@ericsanchezok/synergy-harness/environment/schema"
import type { SandboxHost } from "@ericsanchezok/synergy-harness/sandbox/host"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { ExecutionInputs } from "./inputs"
import { isControlledSessionTempRoot } from "@ericsanchezok/synergy-harness/sandbox/policy"
import { FileAtomicWrite } from "../file/atomic-write"

const Wrapper = ExecutionProtocol.Sandbox.omit({ id: true }).extend({ tempPath: z.string().optional() })
const Sandbox = z.strictObject({
  id: z.string().uuid(),
  digest: z.string().length(64),
  state: z.enum(["preparing", "prepared", "released"]),
  wrapper: Wrapper.optional(),
  policy: z.strictObject({ hash: z.string().length(64), identity: z.string().min(1) }).optional(),
})
const Inputs = z.strictObject({
  digest: z.string().length(64),
  state: z.enum(["preparing", "prepared", "released"]),
  result: ExecutionProtocol.PreparedInputs.optional(),
})
const Receipt = z.strictObject({
  version: z.literal(1),
  id: ExecutionProtocol.ID,
  target: EnvironmentSchema.Target,
  closed: z.boolean(),
  inputs: Inputs.optional(),
  sandboxes: z.array(Sandbox).max(128),
})
type Receipt = z.infer<typeof Receipt>
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

export class NativeExecutionPreparation {
  constructor(
    private readonly options: {
      target: EnvironmentSchema.Target
      directory: string
      inputs: ExecutionInputs
      sandbox?: SandboxHost.Host
      guard(id: string, phase: "prepare" | "release"): Promise<void>
    },
  ) {}

  private filename(id: string) {
    return path.join(this.options.directory, hash(ExecutionProtocol.ID.parse(id)), "preparation.json")
  }
  private lock<T>(id: string, body: () => Promise<T>) {
    ExecutionProtocol.ID.parse(id)
    return withFileLock({ directory: this.options.directory, key: `preparation-${hash(id)}` }, body)
  }
  private async read(id: string) {
    const file = Bun.file(this.filename(id))
    if (!(await file.exists())) return
    const receipt = Receipt.parse(await file.json())
    if (receipt.id !== id || !EnvironmentSchema.sameTarget(receipt.target, this.options.target))
      throw new Error("Native preparation has another original operation or allocation")
    return receipt
  }
  private async write(receipt: Receipt) {
    await AtomicFile.writeJsonAtomic(this.filename(receipt.id), JSON.stringify(Receipt.parse(receipt)), {
      private: true,
      durable: true,
    })
  }
  private empty(id: string): Receipt {
    return { version: 1, id, target: this.options.target, closed: false, sandboxes: [] }
  }

  async prepareInputs(raw: ExecutionProtocol.Inputs) {
    const input = ExecutionProtocol.Inputs.parse(raw)
    const digest = hash(JSON.stringify(input.files.toSorted((a, b) => a.name.localeCompare(b.name))))
    return this.lock(input.id, async () => {
      const receipt = (await this.read(input.id)) ?? this.empty(input.id)
      if (receipt.closed) throw new Error("Original native preparation has closed")
      const previous = receipt.inputs
      if (previous) {
        if (previous.digest !== digest || previous.state === "released")
          throw new Error("Native preparation cannot change or reuse its original input")
        const actual = await this.options.inputs.inspect(input.id)
        if (!actual || actual.digest !== digest)
          throw new Error("Native input preparation remains unknown; inspect its original receipt")
        if (previous.state !== "prepared") {
          receipt.inputs = { digest, state: "prepared", result: actual }
          await this.write(receipt)
        }
        return actual
      }
      await this.options.guard(input.id, "prepare")
      receipt.inputs = { digest, state: "preparing" }
      await this.write(receipt)
      const result = await this.options.inputs.prepare(input)
      receipt.inputs = { digest, state: "prepared", result }
      await this.write(receipt)
      return result
    })
  }

  async prepareSandbox(raw: ExecutionProtocol.SandboxInput) {
    const input = ExecutionProtocol.SandboxInput.parse(raw)
    if (!input.operationID) throw new Error("Durable sandbox preparation requires its original operation")
    const operationID = input.operationID
    const digest = hash(JSON.stringify(input))
    const encoded = hash(JSON.stringify([this.options.target, operationID, digest]))
      .slice(0, 32)
      .split("")
    encoded[12] = "5"
    encoded[16] = ((parseInt(encoded[16], 16) & 3) | 8).toString(16)
    const uuid = encoded.join("")
    const id = [uuid.slice(0, 8), uuid.slice(8, 12), uuid.slice(12, 16), uuid.slice(16, 20), uuid.slice(20)].join("-")
    return this.lock(operationID, async () => {
      const receipt = (await this.read(operationID)) ?? this.empty(operationID)
      if (receipt.closed) throw new Error("Original native preparation has closed")
      const previous = receipt.sandboxes.find((sandbox) => sandbox.id === id)
      if (previous) {
        if (previous.digest !== digest || previous.state !== "prepared" || !previous.wrapper)
          throw new Error("Native sandbox preparation has ended or remains unknown")
        await this.verifyControlledTemporary(input)
        await this.verifyWrapper(previous)
        return ExecutionProtocol.Sandbox.parse({ ...previous.wrapper, id })
      }
      if (receipt.sandboxes.length >= 128) throw new Error("Native preparation has too many sandbox policies")
      await this.options.guard(operationID, "prepare")
      const sandbox: z.infer<typeof Sandbox> = { id, digest, state: "preparing" }
      receipt.sandboxes.push(sandbox)
      await this.write(receipt)
      const controlled = await this.prepareControlledTemporary(input, operationID)
      const wrapper = Wrapper.parse(
        this.options.sandbox?.prepareWrapper(input) ?? {
          command: input.command,
          args: input.args,
          sandboxed: false,
          skipReason: "Target sandbox is unavailable",
        },
      )
      sandbox.wrapper = Wrapper.parse(wrapper)
      if (wrapper.tempPath) {
        const before = await fs.lstat(wrapper.tempPath)
        if (!before.isFile()) throw new Error("Native sandbox policy is not an original regular file")
        const bytes = await fs.readFile(wrapper.tempPath)
        const after = await fs.lstat(wrapper.tempPath)
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size)
          throw new Error("Native sandbox policy changed while its receipt was captured")
        sandbox.policy = {
          hash: createHash("sha256").update(bytes).digest("hex"),
          identity: `${after.dev}:${after.ino}`,
        }
      }
      await this.options.guard(operationID, "prepare")
      await this.verifyControlledTemporary(input, controlled)
      sandbox.state = "prepared"
      await this.write(receipt)
      return ExecutionProtocol.Sandbox.parse({ ...wrapper, id })
    })
  }

  private controlledTemporary(input: ExecutionProtocol.SandboxInput) {
    if (!["darwin", "linux"].includes(process.platform) || input.sandboxMode !== "workspace_write") return []
    return [...new Set(input.extraWritableRoots ?? [])].filter((root) =>
      isControlledSessionTempRoot(input.workspace, root),
    )
  }

  private async prepareControlledTemporary(input: ExecutionProtocol.SandboxInput, operationID: string) {
    const roots = this.controlledTemporary(input)
    if (!roots.length) return
    return FileAtomicWrite.withRoot(input.workspace, async (root) => {
      const identity = await fs.lstat(input.workspace, { bigint: true })
      for (const directory of roots) {
        await this.options.guard(operationID, "prepare")
        await FileAtomicWrite.mkdir(root, path.relative(input.workspace, directory).split(path.sep))
      }
      await this.verifyControlledTemporary(input, identity)
      return identity
    })
  }

  private async verifyControlledTemporary(
    input: ExecutionProtocol.SandboxInput,
    expected?: { dev: bigint; ino: bigint },
  ) {
    const roots = this.controlledTemporary(input)
    if (!roots.length) return
    const before = await fs.lstat(input.workspace, { bigint: true })
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      (expected && (before.dev !== expected.dev || before.ino !== expected.ino))
    )
      throw new Error("Native sandbox controlled temporary root changed its original Workspace")
    for (const directory of roots) {
      const parts = path.relative(input.workspace, directory).split(path.sep)
      let selected = input.workspace
      for (const part of parts) {
        selected = path.join(selected, part)
        const actual = await fs.lstat(selected)
        if (!actual.isDirectory() || actual.isSymbolicLink())
          throw new Error("Native sandbox controlled temporary path is not an independent directory")
      }
    }
    const after = await fs.lstat(input.workspace, { bigint: true })
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino)
      throw new Error("Native sandbox controlled temporary root changed its original Workspace")
  }

  private async verifyWrapper(sandbox: z.infer<typeof Sandbox>) {
    const filename = sandbox.wrapper?.tempPath
    if (!filename) return
    const info = await fs.lstat(filename)
    if (
      !sandbox.policy ||
      !info.isFile() ||
      `${info.dev}:${info.ino}` !== sandbox.policy.identity ||
      createHash("sha256")
        .update(await fs.readFile(filename))
        .digest("hex") !== sandbox.policy.hash
    )
      throw new Error("Native sandbox policy differs from its original physical preparation")
  }

  async inspect(id: string): Promise<ExecutionProtocol.Preparation> {
    return this.lock(id, async () => {
      const receipt = await this.read(id)
      if (!receipt) return { version: 1, id, target: this.options.target, state: "absent", inputs: null, sandboxes: [] }
      let pending =
        receipt.inputs?.state === "preparing" || receipt.sandboxes.some((entry) => entry.state === "preparing")
      let inputs: ExecutionProtocol.PreparedInputs | null = null
      if (receipt.inputs?.state === "prepared") {
        try {
          inputs = (await this.options.inputs.inspect(id)) ?? null
        } catch {
          pending = true
        }
        if (!inputs || inputs.digest !== receipt.inputs.digest) pending = true
      }
      for (const sandbox of receipt.sandboxes)
        if (sandbox.state === "prepared" && sandbox.wrapper)
          try {
            await this.verifyWrapper(sandbox)
          } catch {
            pending = true
          }
      const released =
        receipt.closed &&
        (!receipt.inputs || receipt.inputs.state === "released") &&
        receipt.sandboxes.every((sandbox) => sandbox.state === "released")
      return ExecutionProtocol.Preparation.parse({
        version: 1,
        id,
        target: this.options.target,
        state: pending ? "preparing" : released ? "released" : "prepared",
        inputs,
        sandboxes: receipt.sandboxes.flatMap((entry) =>
          entry.wrapper ? [{ ...entry.wrapper, id: entry.id, released: entry.state === "released" }] : [],
        ),
      })
    })
  }

  async release(id: string) {
    return this.lock(id, async () => {
      const receipt = (await this.read(id)) ?? this.empty(id)
      if (receipt.closed) return
      await this.options.guard(id, "release")
      if (
        (receipt.inputs && receipt.inputs.state !== "released") ||
        receipt.sandboxes.some((sandbox) => sandbox.state !== "released")
      )
        throw new Error("Native preparation still retains original materialized inputs or sandbox policies")
      receipt.closed = true
      await this.write(receipt)
    })
  }

  async releaseSandbox(operationID: string, id: string) {
    return this.lock(operationID, async () => {
      const receipt = await this.read(operationID)
      const sandbox = receipt?.sandboxes.find((entry) => entry.id === id)
      if (!receipt || !sandbox) throw new Error("Sandbox has no original native preparation receipt")
      if (sandbox.state === "released") return
      if (sandbox.state !== "prepared" || !sandbox.wrapper)
        throw new Error("Native sandbox preparation remains unknown")
      await this.options.guard(operationID, "release")
      if (sandbox.wrapper.tempPath && (await Bun.file(sandbox.wrapper.tempPath).exists()))
        await this.verifyWrapper(sandbox)
      this.options.sandbox?.cleanupWrapper(sandbox.wrapper)
      sandbox.state = "released"
      await this.write(receipt)
    })
  }
  async discardInputs(id: string) {
    return this.lock(id, async () => {
      const receipt = await this.read(id)
      if (!receipt?.inputs || receipt.inputs.state === "released") return
      if (receipt.inputs.state !== "prepared") {
        const actual = await this.options.inputs.inspect(id)
        if (!actual || actual.digest !== receipt.inputs.digest)
          throw new Error("Native input preparation remains unknown")
      }
      await this.options.guard(id, "release")
      await this.options.inputs.discard(id, () => this.options.guard(id, "release"))
      receipt.inputs.state = "released"
      await this.write(receipt)
    })
  }

  async admit<T>(id: string, sandboxID: string | undefined, legacy: boolean, body: () => Promise<T>) {
    return this.lock(id, async () => {
      const receipt = await this.read(id)
      if (receipt?.closed) throw new Error("Original native preparation has closed")
      if (receipt?.inputs?.state === "preparing" || receipt?.sandboxes.some((sandbox) => sandbox.state === "preparing"))
        throw new Error("Execution cannot pass an unknown original preparation")
      if (receipt?.inputs?.state === "prepared") {
        const actual = await this.options.inputs.inspect(id)
        if (!actual || actual.digest !== receipt.inputs.digest) throw new Error("Execution input preparation changed")
      }
      if (sandboxID && !legacy) {
        const sandbox = receipt?.sandboxes.find((entry) => entry.id === sandboxID)
        if (!sandbox || sandbox.state !== "prepared" || !sandbox.wrapper)
          throw new Error("Execution has no matching retained native sandbox preparation")
        await this.verifyWrapper(sandbox)
      }
      return body()
    })
  }
}
