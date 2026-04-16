import { $ } from "bun"
import { existsSync } from "fs"
import { createRequire } from "module"
import { dirname, join } from "path"
import { APP_DIST_DIR, CONFIG_UI_DIST_DIR, SYNERGY_DIR, SYNERGY_DIST_DIR } from "../shared/packages"
import { currentGitRemoteUrl } from "../shared/git"

export async function prepareSynergyPackages(version: string, platformNames: string[]) {
  console.log("\n=== prepare synergy packages ===\n")

  const pkg = (await Bun.file(join(SYNERGY_DIR, "package.json")).json()) as {
    name: string
    dependencies: Record<string, string>
  }
  const repositoryUrl = await currentGitRemoteUrl()

  await $`mkdir -p ${join(SYNERGY_DIST_DIR, pkg.name)}`
  await $`cp -r ${join(SYNERGY_DIR, "bin")} ${join(SYNERGY_DIST_DIR, pkg.name, "bin")}`
  await $`cp ${join(SYNERGY_DIR, "script/postinstall.mjs")} ${join(SYNERGY_DIST_DIR, pkg.name, "postinstall.mjs")}`

  const scopedBinaries: Record<string, string> = {}
  for (const name of platformNames) {
    const scopedName = `@ericsanchezok/${name}`
    scopedBinaries[scopedName] = version
    const distDir = join(SYNERGY_DIST_DIR, name)

    await $`cp -r ${APP_DIST_DIR} ${join(distDir, "app")}`
    await $`cp -r ${CONFIG_UI_DIST_DIR} ${join(distDir, "config-ui")}`
    await $`mkdir -p ${join(distDir, "schema")}`
    await $`cp ${join(SYNERGY_DIR, "schema/config.schema.json")} ${join(distDir, "schema/config.schema.json")}`

    const parts = name.replace(`${pkg.name}-`, "").split("-")
    const targetOs = parts[0]
    const targetArch = parts[1]
    const suffix = targetOs === "windows" ? "dll" : targetOs === "darwin" ? "dylib" : "so"
    const vecPkg = `sqlite-vec-${targetOs}-${targetArch}`
    const vec0Filename = `vec0.${suffix}`
    let vec0Copied = false

    const localPath = join(SYNERGY_DIR, "node_modules", vecPkg, vec0Filename)
    if (existsSync(localPath)) {
      await $`cp ${localPath} ${join(distDir, vec0Filename)}`
      vec0Copied = true
    }

    if (!vec0Copied) {
      let searchDir = SYNERGY_DIR
      while (searchDir !== dirname(searchDir)) {
        const bunCacheBase = join(searchDir, "node_modules", ".bun")
        const candidates = [
          join(bunCacheBase, `${vecPkg}@${pkg.dependencies["sqlite-vec"]}`, "node_modules", vecPkg, vec0Filename),
          join(bunCacheBase, "node_modules", vecPkg, vec0Filename),
        ]
        for (const candidate of candidates) {
          if (existsSync(candidate)) {
            await $`cp ${candidate} ${join(distDir, vec0Filename)}`
            vec0Copied = true
            break
          }
        }
        if (vec0Copied) break
        searchDir = dirname(searchDir)
      }
    }

    if (!vec0Copied) {
      throw new Error(`sqlite-vec extension (${vec0Filename}) not found for ${vecPkg}`)
    }

    const astGrepPlatformMap: Record<string, string> = {
      "darwin-arm64": "@ast-grep/cli-darwin-arm64",
      "darwin-x64": "@ast-grep/cli-darwin-x64",
      "linux-arm64": "@ast-grep/cli-linux-arm64-gnu",
      "linux-x64": "@ast-grep/cli-linux-x64-gnu",
      "windows-x64": "@ast-grep/cli-win32-x64-msvc",
    }
    const astGrepPkg = astGrepPlatformMap[`${targetOs}-${targetArch}`]
    if (astGrepPkg) {
      const astGrepBinaryName = targetOs === "windows" ? "ast-grep.exe" : "ast-grep"
      let astGrepCopied = false
      try {
        const req = createRequire(import.meta.url)
        const astPkgJsonPath = req.resolve(`${astGrepPkg}/package.json`)
        const astGrepSource = join(dirname(astPkgJsonPath), astGrepBinaryName)
        if (existsSync(astGrepSource)) {
          await $`cp ${astGrepSource} ${join(distDir, "bin", astGrepBinaryName)}`
          astGrepCopied = true
        }
      } catch {}

      if (!astGrepCopied) {
        let searchDir = SYNERGY_DIR
        while (searchDir !== dirname(searchDir)) {
          const bunCacheBase = join(searchDir, "node_modules", ".bun")
          const candidates = [
            join(bunCacheBase, astGrepPkg, "node_modules", astGrepPkg, astGrepBinaryName),
            join(bunCacheBase, "node_modules", astGrepPkg, astGrepBinaryName),
          ]
          for (const candidate of candidates) {
            if (existsSync(candidate)) {
              await $`cp ${candidate} ${join(distDir, "bin", astGrepBinaryName)}`
              astGrepCopied = true
              break
            }
          }
          if (astGrepCopied) break
          searchDir = dirname(searchDir)
        }
      }

      if (!astGrepCopied) {
        console.warn(`ast-grep binary not found for ${astGrepPkg}`)
      } else if (targetOs !== "windows") {
        await $`chmod +x ${join(distDir, "bin", astGrepBinaryName)}`
      }
    }

    await Bun.write(
      join(distDir, "package.json"),
      JSON.stringify(
        {
          name: scopedName,
          version,
          os: [name.includes("windows") ? "win32" : name.includes("darwin") ? "darwin" : "linux"],
          cpu: [name.includes("arm64") ? "arm64" : "x64"],
          repository: {
            type: "git",
            url: repositoryUrl,
          },
        },
        null,
        2,
      ),
    )
  }

  await Bun.write(
    join(SYNERGY_DIST_DIR, pkg.name, "package.json"),
    JSON.stringify(
      {
        name: "@ericsanchezok/synergy",
        bin: {
          [pkg.name]: `./bin/${pkg.name}`,
        },
        scripts: {
          postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
        },
        version,
        optionalDependencies: scopedBinaries,
        repository: {
          type: "git",
          url: repositoryUrl,
        },
      },
      null,
      2,
    ),
  )

  return platformNames.map((name) => `@ericsanchezok/${name}`)
}
