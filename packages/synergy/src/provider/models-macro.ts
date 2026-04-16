import os from "os"
import path from "path"

function defaultCachePath() {
  const home = process.env.SYNERGY_TEST_HOME || os.homedir()
  return path.join(home, ".synergy", "cache", "models.json")
}

export async function data() {
  const path = Bun.env.MODELS_DEV_API_JSON
  if (path) {
    const file = Bun.file(path)
    if (await file.exists()) {
      return await file.text()
    }
  }

  try {
    return await fetch("https://models.dev/api.json").then((x) => x.text())
  } catch (error) {
    const cache = Bun.file(defaultCachePath())
    if (await cache.exists()) {
      return await cache.text()
    }
    throw error
  }
}
