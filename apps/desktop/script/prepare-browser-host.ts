import fs from "node:fs/promises"
import path from "node:path"
import pkg from "../package.json"

export async function prepareBrowserHost(appDir: string, bundle: string) {
  const source = await Bun.file(bundle).arrayBuffer()
  await fs.rm(appDir, { recursive: true, force: true })
  await fs.mkdir(path.join(appDir, "dist"), { recursive: true })
  await Bun.write(path.join(appDir, "dist/browser-host-main.js"), source)
  await Bun.write(
    path.join(appDir, "package.json"),
    JSON.stringify(
      {
        name: "synergy-browser-host",
        version: pkg.version,
        description: "Synergy Browser Host",
        homepage: pkg.homepage,
        author: pkg.author,
        license: pkg.license,
        type: "module",
        main: "dist/browser-host-main.js",
        dependencies: {},
      },
      null,
      2,
    ) + "\n",
  )
}

if (import.meta.main) {
  await prepareBrowserHost(
    path.resolve(import.meta.dir, "../build/browser-host-app"),
    path.resolve(import.meta.dir, "../dist/browser-host-main.js"),
  )
}
