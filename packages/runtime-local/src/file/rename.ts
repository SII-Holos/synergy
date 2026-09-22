import { dlopen, ptr, read } from "bun:ffi"
import { getSystemErrorName } from "node:util"
import { readFileSync } from "node:fs"
import { FileMutation } from "./mutation"

export namespace FileRename {
  let move: ((from: string, to: string) => void) | undefined
  function initialize() {
    if (process.platform === "win32") {
      const native = dlopen("kernel32.dll", {
        MoveFileExW: { args: ["ptr", "ptr", "u32"], returns: "int" },
        GetLastError: { args: [], returns: "u32" },
      }).symbols
      return (from: string, to: string) => {
        const source = Buffer.from(`${from}\0`, "utf16le"),
          destination = Buffer.from(`${to}\0`, "utf16le")
        if (native.MoveFileExW(ptr(source), ptr(destination), 8)) return
        const errno = native.GetLastError()
        if ([80, 183].includes(errno)) throw new FileMutation.ConflictError()
        throw Object.assign(new Error(`Cannot move file (Windows error ${errno})`), {
          code:
            ({ 2: "ENOENT", 3: "ENOENT", 5: "EACCES", 17: "EXDEV", 32: "EBUSY" } as Record<number, string>)[errno] ??
            "EIO",
          errno,
          syscall: "MoveFileExW",
          path: from,
          dest: to,
        })
      }
    }
    const native =
      process.platform === "darwin"
        ? dlopen("/usr/lib/libSystem.B.dylib", {
            renamex_np: { args: ["ptr", "ptr", "u32"], returns: "int" },
            __error: { args: [], returns: "ptr" },
          }).symbols
        : dlopen(linuxLibrary(), {
            renameat2: { args: ["int", "ptr", "int", "ptr", "u32"], returns: "int" },
            __errno_location: { args: [], returns: "ptr" },
          }).symbols
    return (from: string, to: string) => {
      const source = Buffer.from(`${from}\0`),
        destination = Buffer.from(`${to}\0`)
      const result =
        "renamex_np" in native
          ? native.renamex_np(ptr(source), ptr(destination), 4)
          : native.renameat2(-100, ptr(source), -100, ptr(destination), 1)
      if (result === 0) return
      const location = "__error" in native ? native.__error() : native.__errno_location()
      if (!location) throw new Error("Cannot read native file operation error")
      const errno = read.i32(location)
      const code = getSystemErrorName(-errno)
      if (code === "EEXIST" || code === "ENOTEMPTY") throw new FileMutation.ConflictError()
      throw Object.assign(new Error(`Cannot move file (${code})`), {
        code,
        errno,
        syscall: "rename",
        path: from,
        dest: to,
      })
    }
  }
  function linuxLibrary() {
    if (process.platform !== "linux") throw new Error("Atomic file moves are unavailable on this platform")
    const mapped = readFileSync("/proc/self/maps", "utf8")
    return mapped.match(/\/(?:[^\s]+\/)*ld-musl-[^/\s]+\.so\.1(?=\s|$)/m)?.[0] ?? "libc.so.6"
  }
  // Provenance: https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/sys/stdio.h
  // https://man7.org/linux/man-pages/man2/rename.2.html
  // https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw
  // Local adaptation: publish files and directories without a check-then-overwrite race at the destination.
  export function exclusive(from: string, to: string) {
    if (from.includes("\0") || to.includes("\0")) throw new FileMutation.AccessDeniedError("Invalid file path")
    return (move ??= initialize())(from, to)
  }
}
