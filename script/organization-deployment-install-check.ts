#!/usr/bin/env bun
import path from "node:path"
import { readPackedArchives, withInstalledPackages } from "./package-install-check"
import { cert, key } from "../packages/testing/fixtures/organization-tls"

export async function checkOrganizationDeploymentInstallation(archives: string) {
  return withInstalledPackages(
    await readPackedArchives(archives),
    ["@ericsanchezok/synergy-organization", "@ericsanchezok/synergy-organization-runtime"],
    async (directory, env) => {
      const fixture = path.join(directory, "organization-deployment.ts")
      await Bun.write(
        fixture,
        Bun.file(path.resolve(import.meta.dir, "../test/package/fixture/organization-deployment.ts")),
      )
      await Bun.write(
        path.join(directory, "package-boundary.ts"),
        Bun.file(path.resolve(import.meta.dir, "../test/package/fixture/package-boundary.ts")),
      )
      await Bun.write(
        path.join(directory, "models.json"),
        Bun.file(path.resolve(import.meta.dir, "../packages/testing/fixtures/models-api.json")),
      )
      await Bun.write(path.join(directory, "tls.json"), JSON.stringify({ cert, key }))
      const child = Bun.spawn([process.execPath, "--no-env-file", "--no-bunfig", "--no-install", fixture], {
        cwd: directory,
        env: {
          ...env,
          SYNERGY_HOME: undefined,
          SYNERGY_RUNTIME_ROOT: undefined,
          SYNERGY_TEST_HOME: path.join(directory, "homes"),
          SYNERGY_TEST_ROOT: path.join(directory, "homes"),
          MODELS_DEV_API_JSON: path.join(directory, "models.json"),
          SYNERGY_DISABLE_MODELS_FETCH: "true",
        },
        stdout: "inherit",
        stderr: "inherit",
        timeout: 30_000,
      })
      if (await child.exited) throw new Error("Installed organization deployment recovery acceptance failed")
      console.log("Installed Service and Hosted cohort recovered outside the checkout")
    },
  )
}

if (import.meta.main)
  await checkOrganizationDeploymentInstallation(path.resolve(process.argv[2] ?? ".artifacts/packages"))
