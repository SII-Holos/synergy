import { installCapture } from "./capture.mjs"

if (!process.env.BENCH_CAPTURE_DIR || !process.env.BENCH_GATEWAY_BASE) {
  throw new Error("Session capture requires an isolated recording directory and gateway")
}
installCapture({ root: process.env.BENCH_CAPTURE_DIR, endpoint: process.env.BENCH_GATEWAY_BASE })
