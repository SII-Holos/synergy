// The source pin and local patch preserve Cua's capture bindings and per-PID actuator gates.
// https://github.com/trycua/cua/tree/bf6c76786d938070f4ecf1e44004752f69f518b8/libs/cua-driver
export const CUA_DRIVER_RELEASE = {
  version: "0.30.4",
  commit: "bf6c76786d938070f4ecf1e44004752f69f518b8",
  sourceSha256: "7da3b460e55f3e4d9f79952f29ddb726373c025e15c258c9943a319435b0798b",
  rust: "1.97.1",
  maxBytes: 256 * 1024 * 1024,
} as const
