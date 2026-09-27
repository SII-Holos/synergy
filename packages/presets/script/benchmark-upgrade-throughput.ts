import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
const current = process.cwd()
const baseline = process.env.SYNERGY_BENCH_BASELINE_ROOT
if (!baseline) throw new Error("Set SYNERGY_BENCH_BASELINE_ROOT to an installed baseline checkout")
const fixture = await Bun.file("packages/harness/test/storage/fixtures/v3.0.22.json").json()
const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-import-comparison-"))
try {
  for (const round of [0, 1, 2])
    for (const [name, source] of [
      ["dev", baseline],
      ["updated", current],
    ]) {
      const home = path.join(root, `${round}-${name}`),
        data = path.join(home, ".synergy/data")
      for (let n = 1; n <= 100; n++) {
        const id = String(n).padStart(26, "0")
        const session = JSON.parse(JSON.stringify(fixture.records[0]).replaceAll("00000000000000000000000001", id))
        await Bun.write(path.join(data, ...session.key) + ".json", JSON.stringify(session.value))
        for (let m = 1; m <= 50; m++)
          for (const original of fixture.records.slice(2, 4)) {
            const record = JSON.parse(
              JSON.stringify(original)
                .replaceAll("ses_00000000000000000000000001", "ses_" + id)
                .replaceAll("msg_00000000000000000000000001", "msg_" + String(m).padStart(26, "0"))
                .replaceAll("prt_00000000000000000000000001", "prt_" + String(m).padStart(26, "0")),
            )
            if (record.value.type === "text") record.value.text = "historical content ".repeat(100)
            await Bun.write(path.join(data, ...record.key) + ".json", JSON.stringify(record.value))
          }
      }
      const imp = (file: string) => JSON.stringify(path.join(source, "packages/harness/src", file))
      const code = `
 const {Storage}=await import(${imp("storage/storage.ts")});
 const {TransactionalStore}=await import(${imp("storage/transactional-store.ts")});
 const {SegmentedBackup}=await import(${imp("storage/segmented-backup.ts")});
 const {StorageCompat}=await import(${imp("storage/compat.ts")});
 const {SessionCompat}=await import(${imp("session/compat-import.ts")});
 const store=await TransactionalStore.open({backend:'sqlite',namespace:'benchmark',filename:${JSON.stringify(path.join(home, "db"))}});
 try {await Storage.provide({store,artifactDirectory:${JSON.stringify(data)}},async()=>{
 const backup=new SegmentedBackup(${JSON.stringify(data)},'benchmark'); await backup.freeze(); await StorageCompat.seedLocators(store,backup.sourceRoot,backup.backupID);
 const start=performance.now(); let imported=0;
 while(imported<100) imported+=await SessionCompat.importBatch(100);
 ${name === "updated" ? `const {SessionSegment}=await import(${imp("session/segment-import.ts")}); while(await SessionSegment.cleanup()) {}` : ""}
 if((await store.verify()).issues.length)throw new Error('integrity failure');
 console.log(JSON.stringify({name:${JSON.stringify(name)},round:${round},sessions:100,records:10100,totalMs:performance.now()-start}));
 });}finally{await store.close()}`
      const child = Bun.spawn([process.execPath, "-e", code], {
        cwd: source,
        env: { ...process.env, SYNERGY_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exit, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (exit) throw new Error(err)
      process.stdout.write(out)
    }
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
