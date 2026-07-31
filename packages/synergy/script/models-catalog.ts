import path from "path"
import {
  ModelsDevCatalog,
  REQUIRED_MODELS_DEV_PROVIDERS,
  missingRequiredModelsDevProviders,
} from "../src/provider/models-schemas"

export const PINNED_MODELS_CATALOG_PATH = path.resolve(import.meta.dir, "../test/tool/fixtures/models-api.json")

export async function prepareBuildModelsCatalog(env: Record<string, string | undefined> = process.env) {
  const source = env.MODELS_DEV_API_JSON ? "override" : "pinned"
  const filepath = path.resolve(env.MODELS_DEV_API_JSON || PINNED_MODELS_CATALOG_PATH)
  const input = await Bun.file(filepath)
    .json()
    .catch((error) => {
      throw new Error(`Unable to read models catalog for build: ${filepath}`, { cause: error })
    })
  const parsed = ModelsDevCatalog.safeParse(input)
  if (!parsed.success) {
    throw new Error(`Invalid models catalog for build: ${filepath}`, { cause: parsed.error })
  }

  const missing = missingRequiredModelsDevProviders(parsed.data)
  if (missing.length > 0) {
    throw new Error(`Models catalog for build is missing required providers or models: ${missing.join(", ")}`)
  }

  env.MODELS_DEV_API_JSON = filepath
  return {
    path: filepath,
    source,
    providerCount: Object.keys(parsed.data).length,
    requiredProviders: [...REQUIRED_MODELS_DEV_PROVIDERS],
  }
}
