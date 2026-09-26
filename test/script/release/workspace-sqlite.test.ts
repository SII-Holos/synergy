import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { packWorkspace } from "../../../script/pack-workspace"
import { withInstalledPackages, readPackedArchives } from "../../../script/package-install-check"

test.skipIf(process.platform !== "darwin")(
  "packed generic harness uses its platform resource package without host libraries",
  async () => {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "synergy-sqlite-package-")))
    try {
      const output = path.join(directory, "archives")
      await packWorkspace("packages/harness", output)
      const archives = await readPackedArchives(output)
      const harness = archives.find((pkg) => pkg.name === "@ericsanchezok/synergy-harness")!
      expect(harness.manifest.os).toBeUndefined()
      expect(harness.manifest.private).not.toBe(true)
      await withInstalledPackages(archives, [harness.name], async (installed, env) => {
        const script = `
        import { mock } from "bun:test";
        import fs from "node:fs";
        import { Database } from "bun:sqlite";
        const exists = fs.existsSync;
        mock.module("node:fs", () => ({ ...fs, existsSync: (file) =>
          String(file).endsWith("libsqlite3.dylib") && !String(file).includes("synergy-native-darwin-") ? false : exists(file)
        }));
        const { initializeSqliteEngine } = await import("@ericsanchezok/synergy-harness/storage/sqlite-engine");
        initializeSqliteEngine();
        const db = new Database(":memory:");
        db.run("CREATE TABLE example (value TEXT)");
        db.run("INSERT INTO example VALUES ('packaged')");
        if (db.query("SELECT value FROM example").get().value !== "packaged") throw new Error("Write failed");
        db.close();
      `
        const child = Bun.spawn([process.execPath, "-e", script], {
          cwd: installed,
          env,
          stdout: "pipe",
          stderr: "pipe",
        })
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
        expect(code, stderr).toBe(0)
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  120_000,
)
