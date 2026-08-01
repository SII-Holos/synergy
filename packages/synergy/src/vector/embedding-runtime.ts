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
    const modulePath = path.join(assetRoot, EMBEDDING_RUNTIME_MODULE)
    const wasmPath = path.join(assetRoot, EMBEDDING_RUNTIME_WASM)
    runtime.env.wasm.numThreads = 1
    runtime.env.wasm.wasmPaths = { mjs: pathToFileURL(modulePath).href }
    runtime.env.wasm.wasmBinary = new Uint8Array(await Bun.file(wasmPath).arrayBuffer())
    return runtime
  })()
  return standaloneOnnxRuntime
}

export async function loadEmbeddingTransformersRuntime(): Promise<{
  runtime: TransformersRuntime
  device?: "wasm"
}> {
  if (!isStandalone()) return { runtime: await import("@huggingface/transformers") }
  await loadStandaloneOnnxRuntime()
  return { runtime: await import("@huggingface/transformers"), device: "wasm" }
}

export async function verifyStandaloneEmbeddingRuntime(): Promise<void> {
  const loaded = await loadEmbeddingTransformersRuntime()
  if (loaded.device !== "wasm") throw new Error("Standalone embedding runtime did not select the WASM backend")
  const runtime = await loadStandaloneOnnxRuntime()
  try {
    await runtime.InferenceSession.create(new Uint8Array([0]), { executionProviders: ["wasm"] })
    throw new Error("Invalid ONNX model was unexpectedly accepted")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes("protobuf parsing failed")) throw error
  }
}
