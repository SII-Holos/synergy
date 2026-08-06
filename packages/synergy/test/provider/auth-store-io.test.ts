import { afterAll, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import { Global } from "../../src/global"
import { Auth } from "../../src/provider/api-key"

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code })
}

describe("Auth store transient IO error handling", () => {
  const providerID = `auth-io-${Math.random().toString(36).slice(2)}`

  afterAll(async () => {
    await Auth.remove(providerID).catch(() => {})
  })

  test("transient EPERM during read retries and returns the stored credential", async () => {
    await Auth.set(providerID, { type: "api", key: "stored-key" })

    const realReadFile = fs.readFile
    let calls = 0
    const impl = (async (file: string) => {
      calls++
      if (calls === 1) throw errnoError("EPERM")
      return realReadFile(file, "utf8")
    }) as unknown as typeof fs.readFile
    using _read = spyOn(fs, "readFile").mockImplementation(impl)

    const auth = await Auth.get(providerID)
    expect(auth).toMatchObject({ type: "api", key: "stored-key" })
    expect(calls).toBe(2)
  })

  test("persistent EPERM during read propagates and never wipes the store", async () => {
    await Auth.set(providerID, { type: "api", key: "persist-key" })
    const before = await fs.readFile(Global.Path.authProvider, "utf8")

    const impl = (async () => {
      throw errnoError("EPERM")
    }) as unknown as typeof fs.readFile
    {
      using _read = spyOn(fs, "readFile").mockImplementation(impl)
      await expect(Auth.get(providerID)).rejects.toMatchObject({ code: "EPERM" })
    }

    // The on-disk store must remain untouched: a failed read must never be
    // followed by a write that wipes stored provider credentials.
    const after = await fs.readFile(Global.Path.authProvider, "utf8")
    expect(after).toBe(before)
  })
})
