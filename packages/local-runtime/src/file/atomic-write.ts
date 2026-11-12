import fs from "node:fs"
import path from "node:path"
import { getSystemErrorName } from "node:util"
import { ptr, read } from "bun:ffi"
import { openNativeLibrary } from "../native/ffi"

function initialize() {
  platform()
  const library =
    process.platform === "darwin"
      ? "/usr/lib/libSystem.B.dylib"
      : (fs.readFileSync("/proc/self/maps", "utf8").match(/\/(?:[^\s]+\/)*ld-musl-[^/\s]+\.so\.1(?=\s|$)/m)?.[0] ??
        "libc.so.6")
  const operations = {
    openat: { args: ["int", "ptr", "int", "u32"], returns: "int" },
    mkdirat: { args: ["int", "ptr", "u32"], returns: "int" },
    renameat: { args: ["int", "ptr", "int", "ptr"], returns: "int" },
    unlinkat: { args: ["int", "ptr", "int"], returns: "int" },
  } as const
  const symbols =
    process.platform === "darwin"
      ? openNativeLibrary(
          library,
          { ...operations, __error: { args: [], returns: "ptr" } },
          { variadic: { openat: 3 } },
        ).symbols
      : openNativeLibrary(
          library,
          { ...operations, __errno_location: { args: [], returns: "ptr" } },
          { variadic: { openat: 3 } },
        ).symbols
  function check(result: number) {
    if (result >= 0) return result
    const location = "__error" in symbols ? symbols.__error() : symbols.__errno_location()
    if (!location) throw new Error("Cannot inspect anchored native file error")
    const errno = read.i32(location)
    const code = getSystemErrorName(-errno)
    throw Object.assign(new Error(`Anchored native file operation failed (${code})`), { code, errno })
  }
  return { symbols, check }
}
function platform() {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("Anchored native file publication is unavailable on this platform")
}
let native: ReturnType<typeof initialize> | undefined
const nativeAPI = () => (native ??= initialize())
const flags = fs.constants
const closeOnExec = process.platform === "darwin" ? 0x1000000 : 0x80000
const directoryFlags = flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW | closeOnExec
const name = (value: string) => Buffer.from(value + "\0")
const close = (fd: number) =>
  new Promise<void>((resolve, reject) => fs.close(fd, (error) => (error ? reject(error) : resolve())))
const sync = (fd: number) =>
  new Promise<void>((resolve, reject) => fs.fsync(fd, (error) => (error ? reject(error) : resolve())))
function segments(value: readonly string[]) {
  const parts = [...value]
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || /[\\/\0]/.test(part)))
    throw new Error("Anchored file names require independent relative segments")
  return parts
}
interface Frame {
  fd: number
  open: boolean
  pending: Set<Promise<void>>
}
const frames = new WeakMap<FileAtomicWrite.Root, Frame>()

export namespace FileAtomicWrite {
  export interface Root {
    readonly kind: "native-atomic-file-root"
  }
  export function assertSupported() {
    nativeAPI()
  }
  export async function withRoot<T>(directory: string, body: (root: Root) => Promise<T>): Promise<T> {
    assertSupported()
    if (!path.isAbsolute(directory)) throw new Error("Anchored file root must be absolute")
    const before = await fs.promises.lstat(directory, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink())
      throw new Error("Anchored file root must be an independent directory")
    const held = await fs.promises.open(directory, directoryFlags)
    const frame: Frame = { fd: held.fd, open: true, pending: new Set() }
    try {
      const actual = await held.stat({ bigint: true })
      if (!actual.isDirectory() || actual.dev !== before.dev || actual.ino !== before.ino)
        throw new Error("Anchored file root changed while opening")
      const root: Root = Object.freeze({ kind: "native-atomic-file-root" })
      frames.set(root, frame)
      let outcome: { ok: true; value: T } | { ok: false; error: unknown }
      try {
        outcome = { ok: true, value: await body(root) }
      } catch (error) {
        outcome = { ok: false, error }
      }
      frame.open = false
      const outcomes = await Promise.allSettled(frame.pending)
      if (!outcome.ok) throw outcome.error
      const errors = outcomes.flatMap((value) => (value.status === "rejected" ? [value.reason] : []))
      if (errors.length) throw new AggregateError(errors, "Anchored native file publication did not complete")
      return outcome.value
    } finally {
      frame.open = false
      await held.close()
    }
  }
  // Provenance: https://man7.org/linux/man-pages/man2/openat.2.html
  // https://man7.org/linux/man-pages/man2/rename.2.html
  // Adaptation: directory-relative creation and replacement retain the original filesystem target across parent renames.
  export function write(root: Root, relative: readonly string[], value: Uint8Array) {
    const frame = frames.get(root)
    if (!frame?.open) throw new Error("Anchored file publication requires its original open callback")
    const parts = segments(relative)
    const bytes = new Uint8Array(value)
    const work = writeNative(frame.fd, parts, bytes)
    frame.pending.add(work)
    void work.catch(() => {})
    return work
  }
}
async function writeNative(root: number, parts: string[], bytes: Uint8Array) {
  const { symbols, check } = nativeAPI()
  const opened: number[] = []
  let directory = root
  let file: number | undefined
  const temporary = name(".synergy-publication-" + crypto.randomUUID())
  let created = false
  let failure: { error: unknown } | undefined
  const cleanup: unknown[] = []
  try {
    for (const part of parts.slice(0, -1)) {
      const component = name(part)
      let fd: number
      try {
        fd = check(symbols.openat(directory, ptr(component), directoryFlags, 0))
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
        try {
          check(symbols.mkdirat(directory, ptr(component), 0o700))
          await sync(directory)
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
        }
        fd = check(symbols.openat(directory, ptr(component), directoryFlags, 0))
      }
      opened.push(fd)
      directory = fd
    }
    const fd = check(
      symbols.openat(
        directory,
        ptr(temporary),
        flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | flags.O_NOFOLLOW | closeOnExec,
        0o600,
      ),
    )
    file = fd
    created = true
    let offset = 0
    while (offset < bytes.byteLength) {
      const wrote = await new Promise<number>((resolve, reject) =>
        fs.write(fd, bytes, offset, bytes.byteLength - offset, null, (error, wrote) =>
          error ? reject(error) : resolve(wrote),
        ),
      )
      if (!wrote) throw new Error("Anchored file write made no progress")
      offset += wrote
    }
    await sync(file)
    const last = parts.at(-1)
    if (!last) throw new Error("Anchored file requires its exact target name")
    const target = name(last)
    check(symbols.renameat(directory, ptr(temporary), directory, ptr(target)))
    created = false
    await sync(directory)
  } catch (error) {
    failure = { error }
  } finally {
    if (created) {
      try {
        check(symbols.unlinkat(directory, ptr(temporary), 0))
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") cleanup.push(error)
      }
    }
    const closed = await Promise.allSettled([
      ...(file === undefined ? [] : [close(file)]),
      ...opened.reverse().map(close),
    ])
    cleanup.push(...closed.flatMap((value) => (value.status === "rejected" ? [value.reason] : [])))
  }
  if (failure) {
    if (cleanup.length) throw new AggregateError([failure.error, ...cleanup], "Anchored publication and cleanup failed")
    throw failure.error
  }
  if (cleanup.length) throw new AggregateError(cleanup, "Cannot close anchored native files")
}
