import { expect, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { Identifier } from "../../src/id/id"
import { SessionStaging } from "../../src/session/staging"
import { Storage } from "../../src/storage/storage"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("unpublished Session import identities remain reserved and recover without exposing partial records", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const sessionID = Identifier.ascending("session")
    await SessionStaging.begin(scope.id, [sessionID])
    await Storage.write(["sessions", scope.id, sessionID, "draft"], { retained: true })
    await expect(SessionStaging.begin(scope.id, [sessionID])).rejects.toThrow("reserved")
    expect(await Storage.readMany([["session_index", sessionID]])).toEqual([undefined])
    await SessionStaging.recover()
    expect(await Storage.list(["sessions", scope.id, sessionID])).toEqual([])
    expect(await Storage.list(["storage_staging"])).toEqual([])
    await SessionStaging.recover()
  }))

afterRuntimeTests(() => runtime.close())
