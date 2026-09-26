import { dlopen, ptr } from "bun:ffi"
import fs from "node:fs/promises"
import path from "node:path"

export namespace FileLink {
  let native: ReturnType<typeof initialize> | undefined
  function initialize() {
    return dlopen("kernel32.dll", {
      CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"], returns: "u64" },
      GetFileInformationByHandleEx: { args: ["u64", "int", "ptr", "u32"], returns: "bool" },
      CloseHandle: { args: ["u64"], returns: "bool" },
      GetLastError: { args: [], returns: "u32" },
    }).symbols
  }

  // Provenance: https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_attribute_tag_info
  // Query the reparse entry itself: following the target loses the directory
  // flag for dangling links and cannot distinguish junctions from symlinks.
  export function type(filename: string): "file" | "dir" | "junction" | undefined {
    if (process.platform !== "win32") return undefined
    if (filename.includes("\0")) throw new Error("Invalid symbolic link path")
    const api = (native ??= initialize())
    const name = Buffer.from(`${path.toNamespacedPath(path.resolve(filename))}\0`, "utf16le")
    const handle = api.CreateFileW(ptr(name), 0, 7, null, 3, 0x02200000, null)
    if (handle === 0xffffffffffffffffn || handle === 0n)
      throw new Error(`Cannot inspect symbolic link (Windows error ${api.GetLastError()})`)
    try {
      const information = Buffer.alloc(8)
      if (!api.GetFileInformationByHandleEx(handle, 9, ptr(information), information.length))
        throw new Error(`Cannot inspect symbolic link (Windows error ${api.GetLastError()})`)
      const tag = information.readUInt32LE(4)
      if (tag === 0xa0000003) return "junction"
      if (tag !== 0xa000000c) throw new Error("Unsupported native symbolic link type")
      return information.readUInt32LE(0) & 0x10 ? "dir" : "file"
    } finally {
      if (!api.CloseHandle(handle))
        throw new Error(`Cannot close symbolic link handle (Windows error ${api.GetLastError()})`)
    }
  }

  export async function copy(from: string, to: string, target: string) {
    await fs.symlink(target, to, type(from))
  }
}
