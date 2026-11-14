import { expect, test } from "bun:test"
import { OrganizationInteractionProtocol as Interactions } from "../src/interaction"

const binding = {
  schemaVersion: 1 as const,
  orgID: "org",
  projectID: "project",
  creatorID: "A",
  driverRuntimeID: "runtime",
  bindingEpoch: 1,
}
test("safe interaction queries have finite windows and cannot select native transports or roles", () => {
  expect(Interactions.Query.parse({ operation: "pending", rootSessionID: "root" })).toMatchObject({ limit: 32 })
  for (const changed of [
    { operation: "pending", rootSessionID: "root", limit: 65 },
    { operation: "pending", rootSessionID: "root", url: "https://caller.invalid" },
    {
      operation: "decisions",
      rootSessionID: "root",
      identities: Array.from({ length: 33 }, (_, i) => ({ kind: "permission", requestID: `per-${i}` })),
    },
    {
      operation: "decisions",
      rootSessionID: "root",
      identities: [
        { kind: "question", requestID: "same" },
        { kind: "question", requestID: "same" },
      ],
    },
  ])
    expect(Interactions.Query.safeParse(changed).success).toBeFalse()
})
test("decision queries bind each native identity and omit all submitted question values", () => {
  const query = Interactions.Query.parse({
    operation: "decisions",
    rootSessionID: "root",
    identities: [{ kind: "question", requestID: "question-one" }],
  })
  const result = {
    operation: "decisions" as const,
    rootSessionID: "root",
    sourceSessionID: "root",
    binding,
    runtimeKind: "member" as const,
    items: [
      {
        identity: { kind: "question" as const, requestID: "question-one" },
        state: "resolved" as const,
        winner: {
          sessionID: "root",
          requestID: "question-one",
          decidedAt: 1,
          outcome: { kind: "question" as const, reply: "answer" as const },
        },
      },
    ],
  }
  expect(Interactions.matches(query, result, binding)).toBeTrue()
  expect(Interactions.matches(query, { ...result, sourceSessionID: "another" }, binding)).toBeFalse()
  expect(Interactions.matches(query, { ...result, binding: { ...binding, bindingEpoch: 2 } }, binding)).toBeFalse()
  expect(
    Interactions.matches(
      query,
      {
        ...result,
        items: [{ ...result.items[0], winner: { ...result.items[0].winner, answers: [["private-value"]] } }],
      },
      binding,
    ),
  ).toBeFalse()
})
