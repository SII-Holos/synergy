import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import type { BunPlugin } from "bun"
import {
  EMBEDDING_RUNTIME_MODULE,
  EMBEDDING_RUNTIME_PATH,
  EMBEDDING_RUNTIME_WASM,
} from "../src/vector/embedding-runtime"

const SOURCE_FILES = [EMBEDDING_RUNTIME_MODULE, EMBEDDING_RUNTIME_WASM] as const
export const EMBEDDING_RUNTIME_REQUIRED_PATHS = SOURCE_FILES.map((file) => `${EMBEDDING_RUNTIME_PATH}/${file}`)

export async function stageEmbeddingRuntimeAssets(options: {
  runtimeDir: string
  onnxRuntimeWebDir?: string
}): Promise<void> {
  const source = options.onnxRuntimeWebDir ?? defaultOnnxRuntimeWebDir()
  const destination = path.join(options.runtimeDir, EMBEDDING_RUNTIME_PATH)
  await fs.rm(destination, { recursive: true, force: true })
  await fs.mkdir(destination, { recursive: true })
  for (const file of SOURCE_FILES) {
    const sourceFile = path.join(source, "dist", file)
    if (!(await Bun.file(sourceFile).exists())) {
      throw new Error(`ONNX Web runtime is incomplete; missing dist/${file}: ${source}`)
    }
    await fs.copyFile(sourceFile, path.join(destination, file))
  }
}

export function standaloneEmbeddingBuildPlugin(): BunPlugin {
  const nativeStub = path.join(import.meta.dir, "embedding-native-stub.ts")
  const onnxRuntime = path.join(import.meta.dir, "embedding-onnxruntime-web.ts")
  return {
    name: "standalone-embedding-runtime",
    setup(build) {
      build.onResolve({ filter: /^(onnxruntime-node|sharp)$/ }, (args) => {
        if (!args.importer.replaceAll("\\", "/").includes("/@huggingface/transformers/")) return
        return { path: args.path === "onnxruntime-node" ? onnxRuntime : nativeStub }
      })
    },
  }
}

function defaultOnnxRuntimeWebDir(): string {
  const require = createRequire(import.meta.url)
  return path.dirname(require.resolve("onnxruntime-web/package.json"))
}
