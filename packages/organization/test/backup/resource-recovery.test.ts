import { test } from "bun:test"
import { resourceFixture } from "../support/resource-native"
import { recoverResourceFixture } from "../support/resource-recovery"

test("resource recovery preserves both object heads in independent ports through cold retry and current-policy publication without compute", async () => {
  await using f = await resourceFixture()
  await recoverResourceFixture(f)
}, 30_000)
