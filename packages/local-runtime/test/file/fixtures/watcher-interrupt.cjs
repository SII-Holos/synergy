const fs = require("node:fs/promises")
const path = require("node:path")
const watcher = require(process.argv[2])
const root = process.argv[3]
const marker = process.env.WATCHER_INTERRUPTED
const options = { backend: "inotify", ignorePaths: [], ignoreGlobs: [".*/node_modules/.*"] }
const deadline = setTimeout(() => {
  console.error("watcher did not survive interrupted poll")
  process.exit(2)
}, 30000)
;(async () => {
  await fs.mkdir(root, { recursive: true })
  let resolve
  let reject
  const observed = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  const callback = (error, events) => {
    if (error) reject(error)
    if (events?.some((event) => event.path === path.join(root, "after-signal"))) resolve()
  }
  await watcher.subscribe(root, callback, options)
  const readiness = setInterval(async () => {
    try {
      if ((await fs.readFile(marker, "utf8")) !== "EINTR") return
      clearInterval(readiness)
      await fs.writeFile(path.join(root, "after-signal"), "retained")
    } catch (error) {
      if (error.code !== "ENOENT") reject(error)
    }
  }, 10)
  try {
    await observed
  } finally {
    clearInterval(readiness)
    await watcher.unsubscribe(root, callback, options)
  }
  clearTimeout(deadline)
  console.log(JSON.stringify({ poll: "EINTR", event: "observed", patch: watcher.synergyWatcherPatch }))
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
