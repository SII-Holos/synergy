import { dlopen, FFIType, ptr } from "bun:ffi"
import { existsSync } from "node:fs"
import path from "node:path"
import { Readable, Writable } from "node:stream"

declare const SYNERGY_LIBC: string | undefined

export namespace NativePty {
  const CHUNK = 8192
  export function filename(platform: string = process.platform) {
    return platform === "win32"
      ? "synergy_pty.dll"
      : platform === "darwin"
        ? "libsynergy_pty.dylib"
        : "libsynergy_pty.so"
  }

  export function libraryPath() {
    const libc = typeof SYNERGY_LIBC === "string" ? SYNERGY_LIBC : "glibc"
    const target = `${process.platform}-${process.arch}${process.platform === "linux" ? `-${libc}` : ""}`
    const name = filename()
    const candidates = [
      path.resolve(import.meta.dir, "../../.artifacts/pty", target, name),
      path.resolve(import.meta.dir, "../", name),
      path.resolve(path.dirname(process.execPath), "../", name),
    ]
    const found = candidates.find(existsSync)
    if (!found) throw new Error("Native PTY library is unavailable; run bun dev prepare or reinstall the runtime")
    return found
  }

  function load(filename: string) {
    const library = dlopen(filename, {
      synergy_pty_version: { args: [], returns: FFIType.i32 },
      synergy_pty_spawn: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
      synergy_pty_read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
      synergy_pty_write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
      synergy_pty_resize: { args: [FFIType.i32, FFIType.u16, FFIType.u16], returns: FFIType.i32 },
      synergy_pty_pid: { args: [FFIType.i32], returns: FFIType.i32 },
      synergy_pty_exit: { args: [FFIType.i32], returns: FFIType.i32 },
      synergy_pty_kill: { args: [FFIType.i32], returns: FFIType.i32 },
      synergy_pty_close: { args: [FFIType.i32], returns: FFIType.void },
      synergy_pty_error: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    })
    if (library.symbols.synergy_pty_version() !== 1) {
      library.close()
      throw new Error("Native PTY library version is incompatible")
    }
    return library
  }

  const libraries = new Map<string, ReturnType<typeof load>>()

  export interface Input {
    command: string
    args: string[]
    cwd: string
    env: Record<string, string>
    cols?: number
    rows?: number
    library?: string
  }

  function size(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("Invalid PTY dimensions")
    return value
  }

  export function spawn(input: Input) {
    const location = input.library ?? libraryPath()
    let library = libraries.get(location)
    if (!library) {
      library = load(location)
      libraries.set(location, library)
    }
    const native = library.symbols
    const data = Buffer.from(JSON.stringify({ ...input, cols: size(input.cols ?? 80), rows: size(input.rows ?? 24) }))
    if (data.length > 1024 * 1024) throw new Error("PTY configuration exceeds its bound")
    const handle = native.synergy_pty_spawn(ptr(data), data.length)
    if (handle < 0) {
      const message = Buffer.alloc(8192)
      const length = native.synergy_pty_error(ptr(message), message.length)
      throw new Error(
        `Native PTY spawn failed: ${length > 0 ? message.subarray(0, length).toString() : "unknown error"}`,
      )
    }
    const pid = native.synergy_pty_pid(handle)
    const completion = Promise.withResolvers<number>()
    void completion.promise.catch(() => {})
    let closed = false
    let wake: (() => void) | undefined
    const stdout = new Readable({
      highWaterMark: 64 * 1024,
      read() {
        wake?.()
      },
    })
    stdout.on("error", () => {})
    const write = async (chunk: Buffer) => {
      if (chunk.length > 1024 * 1024) throw new Error("PTY input chunk exceeds its bound")
      for (let offset = 0; offset < chunk.length; offset += CHUNK) {
        const bytes = chunk.subarray(offset, offset + CHUNK)
        for (;;) {
          if (closed) throw new Error("PTY is closed")
          const result = native.synergy_pty_write(handle, ptr(bytes), bytes.length)
          if (result === 0) break
          if (result !== -3) throw new Error("PTY input is unavailable")
          await Bun.sleep(4)
        }
      }
    }
    const stdin = new Writable({
      highWaterMark: 64 * 1024,
      write(chunk: Buffer, _encoding, done) {
        void write(chunk).then(() => done(), done)
      },
    })
    stdin.on("error", () => {})
    const close = () => {
      if (closed) return
      closed = true
      wake?.()
      native.synergy_pty_close(handle)
      stdin.destroy()
      stdout.push(null)
      completion.reject(new Error("PTY closed before output and exit completed"))
    }
    const pump = async () => {
      const buffer = Buffer.alloc(CHUNK)
      let eof = false
      while (!closed) {
        const count = eof ? -2 : native.synergy_pty_read(handle, ptr(buffer), buffer.length)
        if (count > 0) {
          const resumed = Promise.withResolvers<void>()
          wake = resumed.resolve
          if (!stdout.push(Buffer.from(buffer.subarray(0, count)))) await resumed.promise
          wake = undefined
          continue
        }
        if (count === -2) {
          eof = true
          const code = native.synergy_pty_exit(handle)
          if (code >= 0) {
            stdout.push(null)
            completion.resolve(code)
            return
          }
        } else if (count < 0) throw new Error("PTY output is unavailable")
        await Bun.sleep(4)
      }
    }
    void pump().catch((error: Error) => {
      stdout.destroy(error)
      completion.reject(error)
    })
    return {
      pid,
      stdin,
      stdout,
      exited: completion.promise,
      resize(cols: number, rows: number) {
        if (closed) throw new Error("PTY is closed")
        if (native.synergy_pty_resize(handle, size(cols), size(rows)) !== 0) throw new Error("PTY resize failed")
      },
      kill() {
        if (!closed && native.synergy_pty_exit(handle) < 0 && native.synergy_pty_kill(handle) !== 0)
          throw new Error("PTY termination failed")
      },
      close,
    }
  }
}
