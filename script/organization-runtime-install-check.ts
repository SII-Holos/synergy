#!/usr/bin/env bun
import path from "node:path"
import { readPackedArchives, withInstalledPackages } from "./package-install-check"

await withInstalledPackages(
  await readPackedArchives(path.resolve(process.argv[2] ?? ".artifacts/packages")),
  ["@ericsanchezok/synergy-organization-runtime"],
  async (directory, env) => {
    const acceptance = Bun.spawn(
      [process.execPath, "test", "--timeout", "30000", "test/entry.test.ts", "test/hosted-cli.test.ts"],
      {
        cwd: path.resolve(import.meta.dir, "../packages/organization-runtime"),
        env: { ...env, SYNERGY_TEST_ORGANIZATION_RUNTIME_INSTALL: directory },
        stdout: "inherit",
        stderr: "inherit",
      },
    )
    if (await acceptance.exited) throw new Error("Installed machine Runtime acceptance failed")
    console.log("Installed hosted Runtime enrolled and stopped outside the checkout")
  },
)
