import path from "node:path"
import { pathToFileURL } from "node:url"

declare const SYNERGY_STANDALONE: boolean | undefined

export const EMBEDDING_RUNTIME_PATH = "lib/onnxruntime-web"
export const EMBEDDING_RUNTIME_MODULE = "ort-wasm-simd-threaded.asyncify.mjs"
export const EMBEDDING_RUNTIME_WASM = "ort-wasm-simd-threaded.asyncify.wasm"

type TransformersRuntime = typeof import("@huggingface/transformers")
let standaloneOnnxRuntime: Promise<typeof import("onnxruntime-web/wasm")> | undefined

function isStandalone(): boolean {
  return typeof SYNERGY_STANDALONE !== "undefined" && SYNERGY_STANDALONE
}

function loadStandaloneOnnxRuntime(): Promise<typeof import("onnxruntime-web/wasm")> {
  standaloneOnnxRuntime ??= (async () => {
    const runtime = await import("onnxruntime-web/wasm")
    const assetRoot = path.resolve(path.dirname(process.execPath), "..", EMBEDDING_RUNTIME_PATH)
    const moduleUrl = pathToFileURL(path.join(assetRoot, EMBEDDING_RUNTIME_MODULE))
    const wasmUrl = pathToFileURL(path.join(assetRoot, EMBEDDING_RUNTIME_WASM))
    runtime.env.wasm.numThreads = 1
    // transformers.js v4 only preloads the WASM binary and factory when both
    // wasmPaths.wasm and wasmPaths.mjs are set; without them it falls back to
    // importing the factory from import.meta.url, which resolves inside the
    // bundled filesystem ($bunfs) where fetch() rejects the URL.
    runtime.env.wasm.wasmPaths = { mjs: moduleUrl.href, wasm: wasmUrl.href }
    runtime.env.wasm.wasmBinary = new Uint8Array(await Bun.file(wasmUrl).arrayBuffer())
    return runtime
  })()
  return standaloneOnnxRuntime
}

export async function loadEmbeddingTransformersRuntime(): Promise<{
  runtime: TransformersRuntime
  device?: "cpu"
}> {
  if (!isStandalone()) return { runtime: await import("@huggingface/transformers") }
  await loadStandaloneOnnxRuntime()
  // transformers.js v4 dropped "wasm" from its device enum; "cpu" maps to the
  // preloaded WASM execution provider in onnxruntime-web.
  return { runtime: await import("@huggingface/transformers"), device: "cpu" }
}

export async function verifyStandaloneEmbeddingRuntime(): Promise<void> {
  const loaded = await loadEmbeddingTransformersRuntime()
  if (loaded.device !== "cpu") throw new Error("Standalone embedding runtime did not select the WASM backend")
  const runtime = await loadStandaloneOnnxRuntime()
  try {
    await runtime.InferenceSession.create(new Uint8Array([0]), { executionProviders: ["wasm"] })
    throw new Error("Invalid ONNX model was unexpectedly accepted")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes("protobuf parsing failed")) throw error
  }
}
