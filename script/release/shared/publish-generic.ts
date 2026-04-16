import { $ } from "bun"
import path from "path"
import { npmAuthArgs, npmEnsureDistTag, npmVersionExists, retry, waitForNpmVersion } from "./runtime"
import { NPM_REGISTRY } from "./packages"

function distExports(exportsField: Record<string, unknown>) {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(exportsField)) {
    const source =
      typeof value === "string"
        ? value
        : typeof value === "object" && value !== null
          ? (value as { import?: string }).import
          : undefined
    if (!source || typeof source !== "string") {
      output[key] = value
      continue
    }
    const file = source.replace("./src/", "./dist/").replace(".ts", "").replace(".js", "")
    output[key] = {
      import: `${file}.js`,
      types: `${file}.d.ts`,
    }
  }
  return output
}

export async function publishGenericWorkspacePackage(options: {
  dir: string
  name: string
  version: string
  channel: string
}) {
  const packageJsonPath = path.join(options.dir, "package.json")
  const originalText = await Bun.file(packageJsonPath).text()
  const packageJson = JSON.parse(originalText) as {
    exports?: Record<string, unknown>
  }
  if (packageJson.exports) {
    packageJson.exports = distExports(packageJson.exports)
  }
  await Bun.write(packageJsonPath, JSON.stringify(packageJson, null, 2))

  try {
    if (await npmVersionExists(options.name, options.version)) {
      console.log(`${options.name}@${options.version} already exists, reconciling ${options.channel}`)
    } else {
      await $`rm -f *.tgz`.cwd(options.dir).nothrow()
      await $`bun pm pack`.cwd(options.dir)
      const tgz = (await $`ls *.tgz`.cwd(options.dir).text()).trim()
      const authArgs = npmAuthArgs()
      await retry(() =>
        $`npm publish ${tgz} --tag ${options.channel} --registry ${NPM_REGISTRY} --access public ${authArgs}`.cwd(
          options.dir,
        ),
      )
    }
  } finally {
    await Bun.write(packageJsonPath, originalText)
  }

  if (!(await waitForNpmVersion(options.name, options.version))) {
    throw new Error(`expected ${options.name}@${options.version} to appear in npm registry after publish`)
  }
  await npmEnsureDistTag(options.name, options.version, options.channel)
}
