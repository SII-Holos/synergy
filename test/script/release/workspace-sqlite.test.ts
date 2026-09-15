import { expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { packWorkspace } from "../../../script/pack-workspace"

test.skipIf(process.platform !== "darwin")(
  "packed harness opens SQLite without host libraries",
  async () => {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "synergy-sqlite-package-")))
    try {
      const packed = await packWorkspace("packages/harness", path.join(directory, "archives"))
      const unpacked = path.join(directory, "unpacked")
      await mkdir(unpacked)
      const extraction = Bun.spawn(["tar", "-xzf", packed.entry, "-C", unpacked], { stderr: "pipe" })
      expect(await extraction.exited, await new Response(extraction.stderr).text()).toBe(0)
      expect(await Bun.file(path.join(unpacked, "package/dist/libsqlite3.dylib")).exists()).toBe(true)
      expect(await Bun.file(path.join(unpacked, "package/package.json")).json()).toMatchObject({ os: ["darwin"] })
      const engine = pathToFileURL(path.join(unpacked, "package/dist/storage/sqlite-engine.js")).href
      const script = `
      import { mock } from "bun:test";
      import fs from "node:fs";
      import { Database } from "bun:sqlite";
      const exists = fs.existsSync;
      mock.module("node:fs", () => ({ ...fs, existsSync: (file) =>
        String(file).endsWith("libsqlite3.dylib") && !String(file).startsWith(${JSON.stringify(unpacked)})
          ? false : exists(file)
      }));
      const { initializeSqliteEngine } = await import(${JSON.stringify(engine)});
      initializeSqliteEngine();
      const db = new Database(":memory:");
      db.run("CREATE TABLE example (value TEXT)");
      db.run("INSERT INTO example VALUES ('packaged')");
      if (db.query("SELECT value FROM example").get().value !== "packaged") throw new Error("Write failed");
      db.close();
    `
      const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" })
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(code, stderr).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  120_000,
)
