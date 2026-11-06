import { verifyStandaloneEmbeddingRuntime } from "./embedding-runtime"

export async function main() {
  await verifyStandaloneEmbeddingRuntime()
  console.log("Standalone embedding runtime ready")
}
