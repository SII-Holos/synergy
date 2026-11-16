#!/usr/bin/env bun
import path from "node:path"
import { access } from "node:fs/promises"
import { constants } from "node:fs"
import { readPackedArchives, withInstalledPackages } from "./package-install-check"

export async function checkOrganizationInstallation(archives: string) {
  const packages = await readPackedArchives(archives)
  await withInstalledPackages(packages, ["@ericsanchezok/synergy-organization"], async (directory, env) => {
    if (await Bun.file(path.join(directory, "node_modules/@ericsanchezok/synergy-cli/package.json")).exists())
      throw new Error("The programmatic organization service acquired its optional CLI peer")
    const probe = Bun.spawn(
      [
        process.execPath,
        "--no-install",
        "-e",
        'import {openOrganizationService} from "@ericsanchezok/synergy-organization/service"; if(typeof openOrganizationService!=="function")process.exit(1)',
      ],
      { cwd: directory, env, stdout: "inherit", stderr: "inherit" },
    )
    if (await probe.exited) throw new Error("The independent service library cannot load without CLI")
  })
  return withInstalledPackages(
    packages,
    ["@ericsanchezok/synergy-organization", "@ericsanchezok/synergy-cli"],
    async (directory, env) => {
      const entry = path.join(directory, "node_modules/.bin/synergy-org")
      await access(entry, constants.X_OK)
      const direct = Bun.spawn([entry, "--help"], {
        cwd: directory,
        env: { ...env, SYNERGY_HOME: undefined, SYNERGY_RUNTIME_ROOT: undefined },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        direct.exited,
        new Response(direct.stdout).text(),
        new Response(direct.stderr).text(),
      ])
      if (code || !stdout.includes("synergy-org serve"))
        throw new Error(`The installed executable failed direct dispatch: ${stderr}`)
      const acceptance = Bun.spawn(
        [
          process.execPath,
          "test",
          "--timeout",
          "30000",
          "test/entry.test.ts",
          "test/cli-invite.test.ts",
          "test/cli-backup.test.ts",
        ],
        {
          cwd: path.resolve(import.meta.dir, "../packages/organization"),
          env: { ...env, SYNERGY_TEST_ORGANIZATION_INSTALL: directory },
          stdout: "inherit",
          stderr: "inherit",
        },
      )
      if (await acceptance.exited) throw new Error("Installed organization service acceptance failed")
      console.log("Installed organization service passed outside the repository")
    },
  )
}

if (import.meta.main) await checkOrganizationInstallation(path.resolve(process.argv[2] ?? ".artifacts/packages"))
