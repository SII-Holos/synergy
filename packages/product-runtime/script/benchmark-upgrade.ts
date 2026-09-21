import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const count = Number(process.env.SYNERGY_BENCH_UPGRADE_SESSIONS ?? 1000)
if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new Error("Invalid session count")
const fixture = await Bun.file(new URL("../../harness/test/storage/fixtures/v3.0.22.json", import.meta.url)).json()
const ledger = await Bun.file(new URL("../test/storage/fixtures/v3.0.22-migration-ledger.json", import.meta.url)).json()
const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-upgrade-benchmark-"))
try {
  for (const bytes of [32 * 1024, 320 * 1024]) {
    const home = path.join(root, String(bytes))
    const data = path.join(home, ".synergy/data")
    const completed = Object.fromEntries(ledger.completed.map((id: string) => [id, 1]))
    await Bun.write(path.join(data, "meta/migration/log.json"), JSON.stringify(completed))
    for (let index = 1; index <= count; index++) {
      const id = String(index).padStart(26, "0")
      for (const original of fixture.records.slice(0, 4)) {
        const record = JSON.parse(JSON.stringify(original).replaceAll("00000000000000000000000001", id))
        if (record.value.type === "text")
          record.value.text = "historical content ".repeat(Math.ceil(bytes / 19)).slice(0, bytes)
        await Bun.write(path.join(data, ...record.key) + ".json", JSON.stringify(record.value))
      }
    }
    const code = `
      await import(${JSON.stringify(new URL("../src/product-registration.ts", import.meta.url).pathname)});
      const { StorageMaintenance } = await import(${JSON.stringify(new URL("../../harness/src/storage/maintenance.ts", import.meta.url).pathname)});
      const { Storage } = await import(${JSON.stringify(new URL("../../harness/src/storage/storage.ts", import.meta.url).pathname)});
      const { SessionCompat } = await import(${JSON.stringify(new URL("../../harness/src/session/compat-import.ts", import.meta.url).pathname)});
      const started = performance.now();
      await using handle = await StorageMaintenance.open();
      const readyMs = performance.now() - started;
      const pendingAtReady = (await SessionCompat.stats()).pending;
      const samples = async (count) => {
        const latencies = [];
        for (let index = 0; index < count; index++) {
          const start = performance.now();
          await Storage.write(["benchmark-live", String(index)], { index });
          await Storage.read(["benchmark-live", String(index)]);
          latencies.push(performance.now() - start);
          await Bun.sleep(1);
        }
        latencies.sort((a,b) => a-b);
        return latencies[Math.floor(latencies.length * 0.95)];
      };
      const baselineP95 = await samples(100);
      let peakRss = process.memoryUsage().rss;
      const memory = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 20);
      const importStarted = performance.now();
      const importWork = SessionCompat.importBatch(Math.min(${count}, 100));
      const foregroundP95 = await samples(200);
      const imported = await importWork;
      const importMs = performance.now() - importStarted;
      clearInterval(memory);
      if (pendingAtReady !== ${count} || (await handle.store.verify()).issues.length) throw new Error("Benchmark violated upgrade invariants");
      console.log(JSON.stringify({ sessions: ${count}, bodyBytes: ${bytes}, readyMs, pendingAtReady, baselineP95, foregroundP95, imported, importMs, peakRssMiB: peakRss / 1024 ** 2 }));
    `
    const env: NodeJS.ProcessEnv = { ...process.env, SYNERGY_HOME: home }
    delete env.SYNERGY_STORAGE_COMPAT_DEFER
    const child = Bun.spawn([process.execPath, "-e", code], { env, stdout: "pipe", stderr: "pipe" })
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exit) throw new Error(stderr)
    process.stdout.write(stdout)
  }
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
