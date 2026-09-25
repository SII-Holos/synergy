import { readFileSync } from "node:fs"

export function pluginKit() {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string
  }
  return {
    id: "plugin-kit",
    apiVersion: 1 as const,
    version,
    requires: { "plugin-host": version },
    adapters: { cli: new URL("./cli-adapter.js", import.meta.url) },
    register() {},
  }
}
