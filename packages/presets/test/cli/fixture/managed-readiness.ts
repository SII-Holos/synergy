import { RuntimeHandle } from "@ericsanchezok/synergy-harness/lifecycle"

const open = RuntimeHandle.open
RuntimeHandle.open = async (options) => {
  const runtime = await open(options)
  process.stdout.write(JSON.stringify({ fixture: "runtime-open", port: runtime.server?.port }) + "\n")
  await Bun.stdin.text()
  process.stdout.write("fixture-factory-returning\n")
  return runtime
}

const { main } = await import("../../../src/index")
await main()
