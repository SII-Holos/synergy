import { copyFile, mkdir } from "node:fs/promises"
import { Ripgrep } from "synergy/file/ripgrep"

await mkdir("/opt/synergy/bin", { recursive: true })
await copyFile(await Ripgrep.filepath(), "/opt/synergy/bin/rg")
