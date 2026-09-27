import { mock } from "bun:test"
import * as fs from "node:fs"
import path from "node:path"

const input = JSON.parse(process.argv[2]!) as {
  root: string
  platform: string
  maps: "musl" | "glibc"
  target?: "musl" | "glibc"
}
const readFileSync = fs.readFileSync
let mapsReads = 0
mock.module("node:fs", () => ({
  ...fs,
  readFileSync(...args: Parameters<typeof readFileSync>) {
    if (args[0] === "/proc/self/maps") {
      mapsReads++
      return input.maps === "musl"
        ? "700000-710000 r-xp 00000000 00:00 1 /lib/ld-musl-aarch64.so.1\n"
        : "700000-710000 r-xp 00000000 00:00 1 /usr/lib/libc.so.6\n"
    }
    return readFileSync(...args)
  },
}))
Object.defineProperty(process, "platform", { value: input.platform })
const { NativePty } = await import(path.join(input.root, "src/process/native-pty.js"))
const { buildPty } = await import(path.join(input.root, "script/build-pty.js"))
console.log(
  JSON.stringify({
    selected: NativePty.libraryPath(),
    built: await buildPty({ os: "linux", libc: input.target }),
    mapsReads,
  }),
)
