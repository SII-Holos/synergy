import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadEmbeddingTransformersRuntime } from "../../../src/vector/embedding-runtime"
import { InferenceSession } from "../../../script/embedding-onnxruntime-web"

// Regression: transformers.js runs in Node mode under Bun and passes local
// model file paths to InferenceSession.create(). The WASM backend cannot read
// disk paths — its node:fs branch is compiled out — and falls back to
// fetch(path), which Bun rejects with "fetch() URL is invalid". The build
// plugin shim must convert local paths to buffers so the backend reaches ONNX
// protobuf parsing instead.
const loaded = await loadEmbeddingTransformersRuntime()
if (!loaded.device) {
  throw new Error("expected the standalone embedding runtime to select the WASM backend")
}

const modelDir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-embedding-path-"))
const modelPath = path.join(modelDir, "model.onnx")
await fs.writeFile(modelPath, new Uint8Array([0]))

try {
  await InferenceSession.create(modelPath, { executionProviders: ["wasm"] })
  throw new Error("expected an invalid ONNX model to be rejected")
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes("protobuf parsing failed")) {
    throw new Error(`expected protobuf parsing failure, got: ${message}`)
  }
}

console.log("standalone embedding path shim ready")
