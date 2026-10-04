import { ptr } from "bun:ffi"
import {
  identifyDirectory as directoryIdentity,
  identifyFilesystemObject as objectIdentity,
} from "@ericsanchezok/synergy-util/filesystem-identity"
import { openNativeLibrary } from "../native/ffi"

function open() {
  return openNativeLibrary("/usr/lib/libSystem.B.dylib", {
    getattrlist: { args: ["ptr", "ptr", "ptr", "u64", "u32"], returns: "i32" },
  })
}
let library: ReturnType<typeof open> | undefined

function volumeIdentity(filename: string) {
  if (process.platform !== "darwin") return
  library ??= open()
  const attributes = Buffer.alloc(24)
  attributes.writeUInt16LE(5, 0)
  // Provenance: https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/getattrlist.2
  // ATTR_VOL_INFO | ATTR_VOL_UUID returns the persistent volume identity rather than its current device number.
  attributes.writeUInt32LE(0x80040000, 8)
  const result = Buffer.alloc(20)
  const target = Buffer.from(`${filename}\0`)
  if (library.symbols.getattrlist(ptr(target), ptr(attributes), ptr(result), result.length, 0) !== 0) return
  if (result.readUInt32LE(0) !== 20 || result.subarray(4).every((byte) => byte === 0)) return
  return result.subarray(4).toString("hex")
}

export function identifyDirectory(directory: string, allowMissing = false) {
  return directoryIdentity(directory, allowMissing, volumeIdentity)
}

export function identifyFilesystemObject(filename: string) {
  return objectIdentity(filename, volumeIdentity)
}
