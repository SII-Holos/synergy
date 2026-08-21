import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

declare const SYNERGY_STANDALONE: boolean | undefined

export const EMBEDDING_RUNTIME_PATH = "lib/onnxruntime-web"
export const EMBEDDING_RUNTIME_MODULE = "ort-wasm-simd-threaded.asyncify.mjs"
export const EMBEDDING_RUNTIME_WASM = "ort-wasm-simd-threaded.asyncify.wasm"

type TransformersRuntime = typeof import("@huggingface/transformers")
let standaloneOnnxRuntime: Promise<typeof import("onnxruntime-web/wasm")> | undefined

const REMOTE_PROTOCOL = /^(https?|blob|data):/i
const REMOTE_FETCH_TTFB_TIMEOUT_MS = 30_000
const standaloneFetchInstalled = new WeakSet<object>()
let localFileFetchInstalled = false
function isStandalone(): boolean {
  return typeof SYNERGY_STANDALONE !== "undefined" && SYNERGY_STANDALONE
}

function localFilePath(target: string): string {
  return target.startsWith("file:") ? fileURLToPath(target) : target
}

async function fetchLocalFile(target: string): Promise<Response> {
  const filePath = localFilePath(target)
  const file = Bun.file(filePath)
  if (!(await file.exists())) throw new Error(`local embedding asset not found: ${filePath}`)
  return new Response(file.stream(), { headers: { "content-length": String(file.size) } })
}
// Wraps a remote fetch with a TTFB (time-to-first-byte) timeout. Without
// this, an unreachable download source (e.g. huggingface.co behind a network
// that requires a proxy) causes fetch to hang indefinitely, leaving the
// embedding download stuck at 0% with no error. The timeout only covers
// TTFB — once response headers arrive, the body streams at its own pace.
type EnvFetch = (input: string | URL, init?: any) => Promise<any>
async function fetchRemoteWithTimeout(delegate: EnvFetch, input: string | URL, init?: any): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REMOTE_FETCH_TTFB_TIMEOUT_MS).unref()
  const callerSignal = init?.signal
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort()
    else callerSignal.addEventListener("abort", () => controller.abort(), { once: true })
  }
  try {
    const response = await delegate(input, { ...init, signal: controller.signal })
    clearTimeout(timer)
    return response
  } catch (error) {
    clearTimeout(timer)
    if (controller.signal.aborted && !(callerSignal?.aborted ?? false)) {
      throw new Error(
        `Embedding model download timed out after ${REMOTE_FETCH_TTFB_TIMEOUT_MS / 1000}s — ` +
          "the download source may be unreachable. Check your network/proxy settings " +
          "(HTTPS_PROXY) or switch to an alternative source (e.g. hf-mirror) in the embedding config.",
      )
    }
    throw error
  }
}

// onnxruntime-web's browser build reads model files through the global fetch,
// passing raw local paths or file:// URLs after transformers returns a cached
// model path. Bun's fetch rejects raw paths, and in compiled artifacts the
// node:fs branch of onnxruntime-common is dead code, so every mode must serve
// local files through fetch before any ONNX session is created.
function installGlobalLocalFileFetch(): void {
  if (localFileFetchInstalled) return
  localFileFetchInstalled = true
  const native = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : undefined
    if (typeof target === "string" && !REMOTE_PROTOCOL.test(target)) return fetchLocalFile(target)
    return native(input, init)
  }) as typeof globalThis.fetch
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

// transformers.js captures env.fetch when its module evaluates. Depending on
// bundle evaluation order it may have captured the native fetch before the
// global patch above, so wrap it explicitly to keep file:// WASM factory loads
// working in every order.
export function installLocalFileFetch(runtime: TransformersRuntime): void {
  installGlobalLocalFileFetch()
  if (standaloneFetchInstalled.has(runtime.env)) return
  standaloneFetchInstalled.add(runtime.env)
  const delegate = runtime.env.fetch
  runtime.env.fetch = (async (input: string | URL, init?: any) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : undefined
    if (typeof target === "string" && !REMOTE_PROTOCOL.test(target)) return fetchLocalFile(target)
    return fetchRemoteWithTimeout(delegate, input, init)
  }) as typeof runtime.env.fetch
}

export async function loadEmbeddingTransformersRuntime(): Promise<{
  runtime: TransformersRuntime
  device?: "cpu"
}> {
  if (!isStandalone()) {
    const runtime = await import("@huggingface/transformers")
    installLocalFileFetch(runtime)
    return { runtime }
  }
  await loadStandaloneOnnxRuntime()
  const runtime = await import("@huggingface/transformers")
  installLocalFileFetch(runtime)
  // transformers.js v4 dropped "wasm" from its device enum; "cpu" maps to the
  // preloaded WASM execution provider in onnxruntime-web.
  return { runtime, device: "cpu" }
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
