import fs from "node:fs/promises"
import os from "node:os"
import type { RuntimeArtifactProfile } from "../shared/packages"
import path from "path"
import { WEB_DIST_DIR, PRODUCT_RUNTIME_DIR, PRODUCT_RUNTIME_DIST_DIR } from "../shared/packages"
import { assertRuntimeManifest } from "../shared/runtime-contract"

const playwrightRuntimeCheck = "__browser-playwright-runtime-check"
const embeddingRuntimeCheck = "__embedding-runtime-check"

export async function validateLocalArtifacts(platformPackageNames: string[]) {
  console.log("\n=== validate local artifacts ===\n")

  if (!(await Bun.file(path.join(WEB_DIST_DIR, "index.html")).exists())) {
    throw new Error("apps/web/dist/index.html is missing")
  }
  if (!(await Bun.file(path.join(PRODUCT_RUNTIME_DIR, "schema/config.schema.json")).exists())) {
    throw new Error("packages/product-runtime/schema/config.schema.json is missing")
  }

  for (const name of platformPackageNames) {
    await assertRuntimeManifest(path.join(PRODUCT_RUNTIME_DIST_DIR, name), name)
  }

  const currentPlatform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
  const smokeTarget = platformPackageNames.find(
    (name) => name.includes(currentPlatform) && !name.includes("baseline") && !name.includes("musl"),
  )
  if (smokeTarget) {
    for (const result of await smokeRuntimeArtifact(path.join(PRODUCT_RUNTIME_DIST_DIR, smokeTarget), "full")) {
      console.log(result.stdout.trim())
    }
  }
}

export async function smokeRuntimeArtifact(runtimeDir: string, profile: RuntimeArtifactProfile) {
  const stage = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "synergy-artifact-smoke-")))
  const installation = path.join(stage, "runtime")
  const home = path.join(stage, "home")
  try {
    // Run beyond the repository so a missing sidecar cannot resolve through workspace dependencies.
    await fs.cp(runtimeDir, installation, { recursive: true })
    await fs.mkdir(home)
    const binary = path.join(installation, "bin", process.platform === "win32" ? "synergy.exe" : "synergy")
    const checks = profile === "full" ? ["--version", playwrightRuntimeCheck, embeddingRuntimeCheck] : ["--version"]
    const results: Array<{ flag: string; stdout: string }> = []
    for (const flag of checks) {
      const child = Bun.spawn([binary, flag], {
        cwd: installation,
        env: { ...process.env, SYNERGY_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`Runtime artifact check ${flag} failed (${code}): ${stderr}`)
      results.push({ flag, stdout })
    }
    return results
  } finally {
    await fs.rm(stage, { recursive: true, force: true })
  }
}
