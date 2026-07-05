import { $ } from "bun"
import path from "path"
import {
  createPublishablePackageJson,
  readCatalog,
  type DependencyVersionMap,
  type PackageJson,
} from "./package-manifest"
import { npmAuthArgs, npmEnsureDistTag, npmVersionExists, retry, waitForNpmVersion } from "./runtime"
import { NPM_REGISTRY } from "./packages"

export async function publishGenericWorkspacePackage(options: {
  dir: string
  name: string
  version: string
  channel: string
  dependencyVersions?: DependencyVersionMap
}) {
  const packageJsonPath = path.join(options.dir, "package.json")
  const originalText = await Bun.file(packageJsonPath).text()
  const catalog = await readCatalog()

  const sourcePackageJson = JSON.parse(originalText) as PackageJson
  const packageJson = createPublishablePackageJson({
    packageJson: sourcePackageJson,
    version: options.version,
    catalog,
    dependencyVersions: options.dependencyVersions,
  })
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
