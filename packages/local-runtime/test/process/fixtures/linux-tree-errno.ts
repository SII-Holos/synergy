import { mock } from "bun:test"
import * as ffi from "bun:ffi"
import fs from "node:fs"
import path from "node:path"
import { openNativeLibrary } from "../../../src/native/ffi"

const mapped = fs.readFileSync("/proc/self/maps", "utf8")
const libc = mapped.match(/\/(?:[^\s]+\/)*ld-musl-[^/\s]+\.so\.1(?=\s|$)/m)?.[0] ?? "libc.so.6"
const io = openNativeLibrary(libc, {
  pipe2: { args: ["ptr", "i32"], returns: "i32" },
  read: { args: ["i32", "ptr", "u64"], returns: "i64" },
  close: { args: ["i32"], returns: "i32" },
}).symbols
const pipes = new Int32Array(2)
if (io.pipe2(ffi.ptr(pipes), 2048) !== 0) throw new Error("Cannot create nonblocking errno fixture")
const byte = new Uint8Array(1)
const destination = ffi.ptr(byte)
const dlopen = openNativeLibrary
// The real nonblocking read changes errno after an FFI result has crossed into JavaScript.
// This deterministically exercises that boundary; it does not claim to reproduce the CI interruption timing.
mock.module("../../../src/native/ffi", () => ({
  openNativeLibrary(...args: Parameters<typeof dlopen>) {
    const library = dlopen(...args)
    return {
      ...library,
      symbols: new Proxy(library.symbols, {
        get(target, key) {
          const call = Reflect.get(target, key)
          if (typeof call !== "function") return call
          return (...input: unknown[]) => {
            const result = Reflect.apply(call, undefined, input)
            if (Number(io.read(pipes[0]!, destination, 1)) !== -1) throw new Error("Nonblocking read did not fail")
            return result
          }
        },
      }),
    }
  },
}))

const mode = process.argv[3]
if (mode === "missing-symbols")
  mock.module("../../../src/process/native-pty", () => ({ NativePty: { libraryPath: () => libc } }))

const { LinuxTree } = await import("../../../src/process/linux-tree")
const directory = fs.mkdtempSync(path.join(process.argv[2]!, "sy-p-"))
let child: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined
const deadline = Promise.withResolvers<never>()
const timer = setTimeout(() => deadline.reject(new Error("Linux errno fixture deadline exceeded")), 3000)
void deadline.promise.catch(() => {})
async function check() {
  if (mode === "missing-symbols") {
    const marker = path.join(directory, "activated")
    try {
      const worker = await LinuxTree.start(["/bin/sh", "-c", 'touch "$1"', "fixture", marker], directory)
      await worker.remove()
      throw new Error("An incompatible native library allowed process activation")
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Native Linux process library is unavailable"))
        throw error
      if (!(error.cause instanceof Error) || !error.cause.message.includes("synergy_linux_")) throw error
    }
    if (fs.existsSync(marker)) throw new Error("Command ran with an incompatible native library")
    return { state: "unavailable" }
  }
  if (mode === "pidfd-errors") {
    const { NativePty } = await import("../../../src/process/native-pty")
    const native = (await import("../../../src/native/ffi")).openNativeLibrary(NativePty.libraryPath(), {
      synergy_linux_pidfd_open: { args: ["i32"], returns: "i32" },
      synergy_linux_pidfd_signal: { args: ["i32", "i32"], returns: "i32" },
      synergy_linux_close: { args: ["i32"], returns: "i32" },
    }).symbols
    return {
      open: native.synergy_linux_pidfd_open(-1),
      signal: native.synergy_linux_pidfd_signal(-1, 0),
      close: native.synergy_linux_close(-1),
    }
  }
  const reference = LinuxTree.initializeWorker(directory)
  if (mode === "held") {
    child = Bun.spawn(["/bin/sh", "-c", "printf ready; read release"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    const reader = child.stdout.getReader()
    let started = ""
    try {
      while (started.length < 5) {
        const next = await Promise.race([reader.read(), deadline.promise])
        if (next.done) throw new Error("Held child exited before readiness")
        started += new TextDecoder().decode(next.value)
      }
      if (started !== "ready") throw new Error("Held child did not start")
    } finally {
      reader.releaseLock()
    }
    if (LinuxTree.drained()) throw new Error("Published completion while a child is alive")
    if (LinuxTree.inspect(reference).state !== "active") throw new Error("Lost live child ownership")
    let rejected = false
    try {
      LinuxTree.complete()
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Linux descendants are still alive") throw error
      rejected = true
    }
    if (!rejected) throw new Error("Completed a live child tree")
    child.stdin.write("release\n")
    child.stdin.end()
    if ((await Promise.race([child.exited, deadline.promise])) !== 0)
      throw new Error("Held child did not exit normally")
  }
  if (!LinuxTree.drained()) throw new Error("Exited child set remains active")
  LinuxTree.complete()
  return { ...LinuxTree.inspect(reference), held: mode === "held" }
}
try {
  console.log(JSON.stringify(await check()))
} finally {
  clearTimeout(timer)
  if (child && child.exitCode === null) {
    child.kill("SIGKILL")
    await child.exited
  }
  io.close(pipes[0]!)
  io.close(pipes[1]!)
  fs.rmSync(directory, { recursive: true, force: true })
}
