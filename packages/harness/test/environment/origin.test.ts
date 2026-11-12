import { expect, test } from "bun:test"
import path from "node:path"
import { EnvironmentOrigin } from "../../src/environment/origin"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { testEnvironmentRuntime } from "../support/environment-origin"
import { tmpdir } from "../support/fixture"
import { EnvironmentExecution } from "../../src/environment/execution"

function blobs() {
  const values = new Map<string, Uint8Array>()
  return {
    async put(hash: string, bytes: Uint8Array) {
      values.set(hash, bytes.slice())
    },
    async get(hash: string, maximum: number) {
      const bytes = values.get(hash)
      if (!bytes || bytes.length > maximum) throw new Error("Missing or oversized test object")
      return bytes.slice()
    },
    async delete(hash: string) {
      values.delete(hash)
    },
  }
}

test("Host execution origins require their actual composed capability and reject caller labels or copied tokens", async () => {
  await using runtime = await testEnvironmentRuntime()
  await runtime.run(() => {
    const token = runtime.origin("native-action")
    expect(EnvironmentOrigin.selected(token).value).toEqual({
      kind: "host",
      owner: "environment-test-host",
      invocationID: "native-action",
    })
    expect(() =>
      EnvironmentOrigin.selected({ kind: "host", owner: "environment-test-host", invocationID: "native-action" }),
    ).toThrow()
    expect(() => EnvironmentOrigin.selected({ ...token })).toThrow("registered owner")
    expect(() => EnvironmentOrigin.selected({ kind: "legacy-unknown" })).toThrow()
    expect(() => EnvironmentOrigin.selected(undefined)).toThrow()
    expect(() => EnvironmentOrigin.registerHost("late-host")).toThrow()
  })
})

test("captured origins cannot escape into another real Store, artifact configuration or Runtime", async () => {
  await using runtime = await testEnvironmentRuntime()
  await using otherRuntime = await testEnvironmentRuntime()
  await using directory = await tmpdir()
  const foreign = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(directory.path, "foreign.sqlite"),
    namespace: "foreign",
  })
  try {
    const token = await runtime.run(() => runtime.origin("original-owner"))
    await runtime.run(async () => {
      const current = Storage.current()
      await Storage.provide({ store: foreign, artifactDirectory: directory.path }, async () => {
        expect(() => EnvironmentOrigin.selected(token)).toThrow("Storage handle")
        expect(EnvironmentOrigin.selected(runtime.origin("foreign-owner")).value).toMatchObject({
          invocationID: "foreign-owner",
        })
      })
      await Storage.provide({ ...current, artifactDirectory: directory.path }, async () => {
        expect(() => EnvironmentOrigin.selected(token)).toThrow("Storage handle")
      })
      expect(EnvironmentOrigin.selected(token).value).toMatchObject({ invocationID: "original-owner" })
    })
    await otherRuntime.run(() => {
      expect(() => EnvironmentOrigin.selected(token)).toThrow("Runtime")
      expect(() => runtime.origin("wrong-runtime")).toThrow("Runtime")
    })
  } finally {
    await foreign.close()
  }
})

test("captured origins and deferred Session indexes reject mutation of the same Store's namespace", async () => {
  await using runtime = await testEnvironmentRuntime()
  await runtime.run(async () => {
    const token = runtime.origin("before-namespace-change")
    const entries = EnvironmentExecution.sessionEntries({ scopeID: "home", sessionID: "selected" })[
      Symbol.asyncIterator
    ]()
    const options = Storage.current().store.options
    const namespace = options.namespace
    try {
      options.namespace = "replaced-native-namespace"
      expect(() => EnvironmentOrigin.selected(token)).toThrow("Storage")
      await expect(entries.next()).rejects.toThrow("Storage")
    } finally {
      options.namespace = namespace
    }
  })
})

test.each(["blobs", "writerID", "now"] as const)(
  "captured origins and Session indexes reject same-object artifact %s replacement",
  async (field) => {
    await using runtime = await testEnvironmentRuntime()
    await runtime.run(async () => {
      const current = Storage.current()
      const objects = { blobs: blobs(), writerID: "original-writer", now: () => 1 }
      await Storage.provide({ ...current, artifactObjects: objects }, async () => {
        const token = runtime.origin("before-artifact-change")
        const entries = EnvironmentExecution.sessionEntries({ scopeID: "home", sessionID: "selected" })[
          Symbol.asyncIterator
        ]()
        if (field === "blobs") objects.blobs = blobs()
        if (field === "writerID") objects.writerID = "replacement-writer"
        if (field === "now") objects.now = () => 2
        expect(() => EnvironmentOrigin.selected(token)).toThrow("Storage")
        await expect(entries.next()).rejects.toThrow("Storage")
      })
    })
  },
)
