import { expect, test } from "bun:test"
import { createPluginResourceService } from "../../src/plugin/resource-service"

test("resource actions target the current owner and late cleanup cannot release a replacement", () => {
  const service = createPluginResourceService()
  const resource = { kind: "file" as const, uri: "example.txt" }
  expect(() => service.open(resource)).toThrow("unavailable")
  const received: string[] = []
  const releaseA = service.register((value) => {
    received.push(`a:${value.uri}`)
    return true
  })
  expect(service.open(resource)).toBe(true)
  const releaseB = service.register((value) => {
    received.push(`b:${value.uri}`)
    return false
  })
  releaseA()
  expect(service.open(resource)).toBe(false)
  expect(received).toEqual(["a:example.txt", "b:example.txt"])
  releaseB()
  releaseB()
  expect(() => service.open(resource)).toThrow("unavailable")
})
