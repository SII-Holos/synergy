// Provenance: https://github.com/trycua/cua/tree/d752c6a63e412f42ec1c7a1bdf098eb7f8b67c91/libs/cua-driver
// Local adaptation: pinned MIT worker plus exact-window proof and dispatch guards; no upstream agent prompts.
export const CUA_DRIVER_RELEASE = {
  version: "0.36.0",
  commit: "d752c6a63e412f42ec1c7a1bdf098eb7f8b67c91",
  sourceSha256: "0be487681a0f23cd96f7ed82cbc4c3d4e07aed5f79b02b59786532225823c334",
  rust: "1.99.1",
  maxBytes: 256 * 1024 * 1024,
} as const
