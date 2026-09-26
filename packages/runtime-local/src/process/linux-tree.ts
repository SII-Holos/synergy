import { dlopen, ptr, read } from "bun:ffi"
import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { z } from "zod"

export namespace LinuxTree {
  export const Reference = z.object({
    bootID: z.string().uuid(),
    pid: z.number().int().positive(),
    start: z.string().regex(/^\d+$/),
    receipt: z.string(),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  export type Reference = z.infer<typeof Reference>
  const State = z.object({
    version: z.literal(1),
    reference: Reference,
    owner: z.object({ pid: z.number().int().positive(), start: z.string() }),
    complete: z.boolean(),
  })
  let native: ReturnType<typeof initialize> | undefined
  let self: Reference | undefined
  function initialize() {
    if (process.platform !== "linux") throw new Error("Linux process ownership is unavailable")
    const mapped = fs.readFileSync("/proc/self/maps", "utf8")
    const library = mapped.match(/\/(?:[^\s]+\/)*ld-musl-[^/\s]+\.so\.1(?=\s|$)/m)?.[0] ?? "libc.so.6"
    return dlopen(library, {
      prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
      waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" },
      syscall: { args: ["i64", "i64", "i64", "i64", "i64"], returns: "i64" },
      close: { args: ["i32"], returns: "i32" },
      __errno_location: { args: [], returns: "ptr" },
    }).symbols
  }
  const runtime = () => (native ??= initialize())
  const errno = () => {
    const pointer = runtime().__errno_location()
    if (!pointer) throw new Error("Cannot read Linux process status")
    return read.i32(pointer)
  }
  const boot = () => fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  function status(pid: number) {
    try {
      const value = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
      const fields = value
        .slice(value.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/)
      if (!/^\d+$/.test(fields[19] ?? "")) throw new Error("Invalid Linux process identity")
      return { parent: Number(fields[1]), start: fields[19]! }
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined
      throw error
    }
  }
  function validateDirectory(receipt: string) {
    const directory = path.dirname(receipt)
    if (
      !path.isAbsolute(receipt) ||
      path.basename(receipt) !== "tree.json" ||
      !/^sy-p-[a-zA-Z0-9]+$/.test(path.basename(directory))
    )
      throw new Error("Invalid Linux ownership receipt")
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("Linux ownership receipt is not private")
    return directory
  }
  function readReceipt(receipt: string) {
    validateDirectory(receipt)
    const descriptor = fs.openSync(receipt, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const stat = fs.fstatSync(descriptor)
      if (!stat.isFile() || stat.size > 16384 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
        throw new Error("Invalid Linux ownership evidence")
      return State.parse(JSON.parse(fs.readFileSync(descriptor, "utf8")))
    } finally {
      fs.closeSync(descriptor)
    }
  }
  function state(reference: Reference) {
    const value = readReceipt(reference.receipt)
    if (JSON.stringify(value.reference) !== JSON.stringify(Reference.parse(reference)))
      throw new Error("Linux ownership evidence belongs to another process")
    return value
  }
  function publish(value: z.infer<typeof State>, first = false) {
    const filename = first ? value.reference.receipt : `${value.reference.receipt}.${randomBytes(8).toString("hex")}`
    const descriptor = fs.openSync(filename, "wx", 0o600)
    try {
      fs.writeFileSync(descriptor, JSON.stringify(value))
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    if (!first) fs.renameSync(filename, value.reference.receipt)
    const directory = fs.openSync(path.dirname(filename), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
    try {
      fs.fsyncSync(directory)
    } finally {
      fs.closeSync(directory)
    }
  }
  // Provenance: https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html
  // Reparenting keeps double-forked, detached and empty-environment descendants waitable by this worker.
  export function initializeWorker(directory: string) {
    if (self) throw new Error("Linux process worker is already initialized")
    if (runtime().prctl(36, 1, 0, 0, 0) !== 0) throw new Error(`Cannot initialize Linux subreaper: ${errno()}`)
    const own = status(process.pid)
    const owner = status(process.ppid)
    if (!own || !owner) throw new Error("Cannot identify Linux process ownership")
    const reference = {
      bootID: boot(),
      pid: process.pid,
      start: own.start,
      receipt: path.join(directory, "tree.json"),
      token: randomBytes(32).toString("hex"),
    }
    validateDirectory(reference.receipt)
    publish({ version: 1, reference, owner: { pid: process.ppid, start: owner.start }, complete: false }, true)
    return (self = reference)
  }
  export function current() {
    if (!self) throw new Error("Linux worker has not established native ownership")
    return self
  }
  export function capture(pid: number): Reference {
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
    const input = args.at(-1)
    if (!input || path.basename(input) !== "input.json") throw new Error("Linux process is not an owned worker")
    const receipt = path.join(path.dirname(input), "tree.json")
    const value = readReceipt(receipt)
    const reference = value.reference
    if (
      reference.receipt !== receipt ||
      reference.pid !== pid ||
      reference.bootID !== boot() ||
      status(pid)?.start !== reference.start
    )
      throw new Error("Linux worker identity changed before activation")
    state(reference)
    return reference
  }
  export function inspect(reference: Reference): { state: "active" } | { state: "exited" } {
    if (reference.bootID !== boot()) return { state: "exited" }
    if (state(reference).complete) return { state: "exited" }
    if (status(reference.pid)?.start !== reference.start)
      throw new Error(
        "Linux process supervisor exited without proving descendant completion; Workspace ownership remains uncertain",
      )
    return { state: "active" }
  }
  // Provenance: https://man7.org/linux/man-pages/man2/waitpid.2.html
  // ECHILD after reaping all child kinds is the completion proof; /proc enumeration is only used for signals.
  export function drained() {
    current()
    const value = new Int32Array(1)
    for (let count = 0; count < 65536; count++) {
      const result = runtime().waitpid(-1, ptr(value), 1 | 0x40000000)
      if (result > 0) continue
      if (result === 0) return false
      const code = errno()
      if (code === 10) return true
      if (code !== 4) throw new Error(`Cannot verify Linux descendant completion: ${code}`)
    }
    return false
  }
  export function complete() {
    const reference = current()
    if (!drained()) throw new Error("Linux descendants are still alive")
    publish({ ...state(reference), complete: true })
  }
  // Provenance: https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html
  // A pidfd pins the signal target while its parent/start identity is verified, avoiding PID-reuse races.
  function signal(pid: number, valid: () => boolean, value: number) {
    const descriptor = Number(runtime().syscall(434, pid, 0, 0, 0))
    if (descriptor < 0) {
      const code = errno()
      if (code === 3) return
      throw new Error(`Cannot open Linux process descriptor: ${code}`)
    }
    try {
      if (!valid()) return
      if (Number(runtime().syscall(424, descriptor, value, 0, 0)) !== 0 && errno() !== 3)
        throw new Error(`Cannot signal Linux process descriptor: ${errno()}`)
    } finally {
      runtime().close(descriptor)
    }
  }
  export function terminate(reference: Reference) {
    if (inspect(reference).state === "exited") return
    signal(reference.pid, () => status(reference.pid)?.start === reference.start, 15)
  }
  export function terminateDescendants(value: "SIGTERM" | "SIGKILL") {
    current()
    const tasks = fs.readdirSync("/proc/self/task")
    for (const tid of tasks) {
      let children: string
      try {
        children = fs.readFileSync(`/proc/self/task/${tid}/children`, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      for (const child of children.trim().split(/\s+/).filter(Boolean)) {
        const pid = Number(child)
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid Linux child identity")
        signal(pid, () => status(pid)?.parent === process.pid, value === "SIGTERM" ? 15 : 9)
      }
    }
  }
  export function retire(reference: Reference) {
    if (reference.bootID !== boot()) return
    const value = state(reference)
    if (!value.complete || status(value.owner.pid)?.start === value.owner.start) return
    fs.rmSync(validateDirectory(reference.receipt), { recursive: true, force: true })
  }
  export async function start(command: string[], directory: string) {
    try {
      signal(process.pid, () => true, 0)
    } catch (cause) {
      throw new Error("Native Linux process supervision requires pidfd support", { cause })
    }
    const child = spawn(command[0]!, command.slice(1), { cwd: directory, detached: true, stdio: "ignore" })
    const exited = new Promise<void>((resolve, reject) => child.once("exit", () => resolve()).once("error", reject))
    void exited.catch(() => {})
    await once(child, "spawn")
    return {
      async remove() {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
        await exited
      },
    }
  }
}
