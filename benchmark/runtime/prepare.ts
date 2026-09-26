import { copyFile, mkdir } from "node:fs/promises"
import { Ripgrep } from "@ericsanchezok/synergy-runtime-local/file/ripgrep"
import path from "node:path"

import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { createLocalHost } from "@ericsanchezok/synergy-runtime-local"

const context = RuntimeContext.create(createLocalHost())
await context
  .run(async () => {
    const directory = process.argv[2] ?? "/opt/synergy/bin"
    await mkdir(directory, { recursive: true })
    await copyFile(await Ripgrep.filepath(), path.join(directory, "rg"))
  })
  .finally(() => context.dispose())
