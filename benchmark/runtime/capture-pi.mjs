import { installCapture } from "./capture.mjs"

export default function nativeCapture() {
  installCapture({ root: process.env.BENCH_CAPTURE_DIR, endpoint: process.env.BENCH_GATEWAY_BASE })
}
