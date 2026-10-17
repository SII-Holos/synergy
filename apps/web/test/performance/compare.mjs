import path from "node:path"

const [beforePath, afterPath, timing] = process.argv.slice(2)
if (!beforePath || !afterPath)
  throw Error("Usage: bun compare.mjs <baseline directory> <optimized directory> [--timing]")
const before = await Bun.file(path.join(beforePath, "report.json")).json()
const after = await Bun.file(path.join(afterPath, "report.json")).json()
const bytes = (report) => Object.values(report.websocket).reduce((total, category) => total + category.bytes, 0)
const bodies = (report) =>
  Object.entries(report.hotRequests)
    .filter(([route]) => route.endsWith("/content"))
    .reduce((total, [, count]) => total + count, 0)
const streamingBodies = (report) =>
  Object.entries(report.streamRequests)
    .filter(([route]) => route.endsWith("/content"))
    .reduce((total, [, count]) => total + count, 0)
const result = {
  categories: Object.fromEntries(
    [...new Set([...Object.keys(before.websocket), ...Object.keys(after.websocket)])].map((name) => [
      name,
      {
        before: before.websocket[name] ?? { frames: 0, bytes: 0 },
        after: after.websocket[name] ?? { frames: 0, bytes: 0 },
      },
    ]),
  ),
  baselineBytes: bytes(before),
  optimizedBytes: bytes(after),
  reduction: 1 - bytes(after) / bytes(before),
  baselineP95: before.p95,
  optimizedP95: after.p95,
  baselineBodyRequests: bodies(before),
  optimizedBodyRequests: bodies(after),
  optimizedStreamingBodyRequests: streamingBodies(after),
}
await Bun.write(path.join(afterPath, "comparison.json"), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (
  result.optimizedBodyRequests !== 0 ||
  result.optimizedStreamingBodyRequests !== 0 ||
  after.errors.length ||
  (after.hotRequests["/session/:session/timeline/page"] ?? 0) !== 0
)
  throw Error("Deterministic traffic/navigation acceptance failed")
if (timing === "--timing" && after.p95 > 200) throw Error("Fixed-device timing acceptance failed")
