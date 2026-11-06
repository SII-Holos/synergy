import os from "os"
import path from "path"

function defaultCachePath() {
  const home = process.env.SYNERGY_HOME || process.env.SYNERGY_TEST_HOME || os.homedir()
  return path.join(home, ".synergy", "cache", "models.json")
}

function fetchDisabled() {
  const value = process.env.SYNERGY_DISABLE_MODELS_FETCH?.toLowerCase()
  return value === "true" || value === "1"
}

async function cachedData() {
  try {
    const cache = Bun.file(defaultCachePath())
    if (await cache.exists()) return await cache.text()
  } catch {}
  return "{}"
}

export async function data() {
  const source = Bun.env.MODELS_DEV_API_JSON
  if (source) {
    try {
      const file = Bun.file(source)
      if (await file.exists()) return await file.text()
    } catch {}
  }

  if (fetchDisabled()) return cachedData()

  try {
    const response = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(10_000),
    })
    if (response.ok) return await response.text()
  } catch {}

  return cachedData()
}
