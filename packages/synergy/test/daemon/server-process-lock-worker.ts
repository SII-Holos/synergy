import fs from "fs/promises"
import { ServerProcessLock } from "../../src/util/server-process-lock"

const id = process.env.LOCK_WORKER_ID!
const readyPath = process.env.LOCK_READY_PATH!
const startPath = process.env.LOCK_START_PATH!
const resultPath = process.env.LOCK_RESULT_PATH!
const releasePath = process.env.LOCK_RELEASE_PATH!
const resumePublishPath = process.env.LOCK_RESUME_PUBLISH_PATH

const pauseBeforePublishPath = process.env.LOCK_PAUSE_BEFORE_PUBLISH_PATH
if (pauseBeforePublishPath) {
  const originalLink = fs.link
  let paused = false
  fs.link = async (source, destination) => {
    if (!paused && destination === ServerProcessLock.path()) {
      paused = true
      await fs.appendFile(pauseBeforePublishPath, `${id}\n`)
      const resumePath = resumePublishPath ?? releasePath
      while (!(await Bun.file(resumePath).exists())) await Bun.sleep(2)
    }
    return originalLink(source, destination)
  }
}

if (process.env.LOCK_PREPARE_UNREADABLE === "1") {
  await fs.mkdir(ServerProcessLock.path(), { recursive: true })
}

await fs.appendFile(readyPath, `${id}\n`)
while (!(await Bun.file(startPath).exists())) await Bun.sleep(2)

try {
  const acquired = await ServerProcessLock.acquire()
  const lock = await ServerProcessLock.read()
  await fs.appendFile(resultPath, `${JSON.stringify({ id, acquired: true, ownerToken: lock?.ownerToken })}\n`)
  while (!(await Bun.file(releasePath).exists())) await Bun.sleep(2)
  await acquired.release()
  process.exit(0)
} catch (error) {
  if (error instanceof ServerProcessLock.AlreadyRunningError) {
    await fs.appendFile(resultPath, `${JSON.stringify({ id, acquired: false })}\n`)
    process.exit(0)
  }
  await fs.appendFile(resultPath, `${JSON.stringify({ id, error: String(error) })}\n`)
  process.exit(1)
}
