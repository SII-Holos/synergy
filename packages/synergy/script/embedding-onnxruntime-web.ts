import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"
import * as onnx from "onnxruntime-web/wasm"

type CreateOptions = Parameters<typeof onnx.InferenceSession.create>[1]

const originalCreate = onnx.InferenceSession.create.bind(onnx.InferenceSession)

// transformers.js runs in Node mode under Bun and passes local model file
// paths (strings) to InferenceSession.create(). The WASM backend only accepts
// buffers — its node:fs branch is compiled out — and rejects disk paths with
// "fetch() URL is invalid". Resolve any string input (disk path, file:// URL,
// or http(s) URL) to a buffer before handing it to the backend.
async function resolveModel(model: Uint8Array | string): Promise<Uint8Array> {
  if (typeof model !== "string") return model
  if (/^https?:\/\//i.test(model)) {
    const response = await fetch(model)
    if (!response.ok) {
      throw new Error(`failed to load model from ${model}: ${response.status} ${response.statusText}`)
    }
    return new Uint8Array(await response.arrayBuffer())
  }
  const filePath = model.startsWith("file://") ? fileURLToPath(model) : model
  return new Uint8Array(await fs.readFile(filePath))
}

export const InferenceSession = {
  ...onnx.InferenceSession,
  async create(model: Uint8Array | string, options?: CreateOptions) {
    return originalCreate(await resolveModel(model), options)
  },
}

export * from "onnxruntime-web/wasm"
export { default } from "onnxruntime-web/wasm"
