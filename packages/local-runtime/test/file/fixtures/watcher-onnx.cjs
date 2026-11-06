const fs = require("node:fs/promises")
const path = require("node:path")
const [bindingPath, wrapperPath, onnxPath, root, order] = process.argv.slice(2)
const { createWrapper } = require(wrapperPath)

;(async () => {
  if (order === "before") require(onnxPath)
  const binding = require(bindingPath)
  const watcher = createWrapper(binding)
  const target = path.join(root, "after-onnx")
  let resolve
  let reject
  const observed = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  const subscription = await watcher.subscribe(
    root,
    (error, events) => {
      if (error) reject(error)
      if (events?.some((event) => event.path === target)) resolve()
    },
    { backend: "inotify", ignore: ["node_modules", "**/node_modules/**"] },
  )
  try {
    if (order === "after") require(onnxPath)
    await fs.writeFile(target, "retained")
    await observed
  } finally {
    await subscription.unsubscribe()
  }
  console.log(JSON.stringify({ patch: binding.synergyWatcherPatch, onnx: "loaded", event: "observed" }))
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
