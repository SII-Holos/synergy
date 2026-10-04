import { expect, test } from "bun:test"
import { issueTitle, traceDisplayName } from "../../../src/components/performance/presentation"

test("trace names use recorded HTTP method and path without inventing missing fields", () => {
  expect(traceDisplayName("http.request", { method: "GET", path: "/sessions" })).toBe("GET /sessions")
  expect(traceDisplayName("http.request", { method: "GET" })).toBe("http.request")
  expect(traceDisplayName("tool.execute", { tool: "read_file" })).toBe("tool.execute")
})

test("known performance issue categories use translatable names and preserve unknown diagnostic titles", () => {
  expect(issueTitle({ code: "PERF_HTTP_SLOW_REQUEST", title: "Slow http.request" })).toEqual({
    id: "app.performance.issue.slowRequest",
    message: "Slow HTTP request",
  })
  expect(issueTitle({ code: "PERF_TOOL_EXECUTION_FAILED", title: "Tool failed" })).toEqual({
    id: "app.performance.issue.toolFailed",
    message: "Tool execution failed",
  })
  expect(issueTitle({ code: "PERF_STORAGE_OPERATION_ERROR", title: "Storage operation failed" })).toEqual({
    id: "app.performance.issue.storageFailed",
    message: "Storage operation failed",
  })
  expect(issueTitle({ code: "CUSTOM_DIAGNOSTIC", title: "Publisher diagnostic" })).toBe("Publisher diagnostic")
})
