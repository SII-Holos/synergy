import { expect, test } from "bun:test"
import { WorkspaceErrors } from "../../src/workspace/errors"

test("directory replacement retains its typed identity across the failure codec without matching messages", () => {
  const error = new WorkspaceErrors.DirectoryIdentityChangedError()
  const failure = WorkspaceErrors.Failure.parse(JSON.parse(JSON.stringify(WorkspaceErrors.failure(error))))
  const restored = WorkspaceErrors.restore(failure)
  expect(restored).toBeInstanceOf(WorkspaceErrors.DirectoryIdentityChangedError)
  expect(WorkspaceErrors.failure(restored)).toEqual(failure)
  for (const unverified of [
    { ...failure, code: undefined },
    { ...failure, name: "Error" },
    { ...failure, code: "IDENTITY_UNVERIFIED" },
    WorkspaceErrors.failure(new Error(error.message)),
  ]) {
    expect(WorkspaceErrors.restore(unverified)).not.toBeInstanceOf(WorkspaceErrors.DirectoryIdentityChangedError)
  }
})
