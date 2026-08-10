import { expect, test } from "bun:test"
import {
  DESKTOP_SERVER_SHUTDOWN_TIMEOUT_MS,
  MAX_EXECUTION_CANCEL_GRACE_MS,
  SYSTEMD_SERVER_SHUTDOWN_TIMEOUT_SECONDS,
  resolveRuntimeShutdownTimeoutMs,
} from "../src/runtime-shutdown"

test("keeps runtime and supervisor deadlines outside supported cancellation grace", () => {
  expect(resolveRuntimeShutdownTimeoutMs(0)).toBe(5_000)
  expect(resolveRuntimeShutdownTimeoutMs(5_000)).toBe(10_000)
  expect(resolveRuntimeShutdownTimeoutMs(MAX_EXECUTION_CANCEL_GRACE_MS)).toBe(65_000)
  expect(DESKTOP_SERVER_SHUTDOWN_TIMEOUT_MS).toBe(70_000)
  expect(SYSTEMD_SERVER_SHUTDOWN_TIMEOUT_SECONDS).toBe(70)
  expect(DESKTOP_SERVER_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(
    resolveRuntimeShutdownTimeoutMs(MAX_EXECUTION_CANCEL_GRACE_MS),
  )
})
