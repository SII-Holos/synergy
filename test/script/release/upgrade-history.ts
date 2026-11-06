import { expect } from "bun:test"

type HistoryMessage = { info: { id: string; role: string }; parts: unknown[] }

export function expectRetainedHistory(expected: readonly HistoryMessage[], actual: readonly HistoryMessage[]) {
  const snapshot = (messages: readonly HistoryMessage[]) =>
    messages.map(({ info, parts }) => ({ id: info.id, role: info.role, parts }))
  expect(snapshot(actual)).toEqual(snapshot(expected))
}
