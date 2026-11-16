import { expect, test } from "bun:test"
import { OrganizationIdentity as Identity } from "../src/index"

test("login identity uses explicit normalization while passwords preserve their exact text", () => {
  expect(Identity.LoginName.parse(" Ａlice@Example.COM ")).toBe("alice@example.com")
  expect(Identity.LoginName.safeParse("alice/example").success).toBe(false)
  expect(Identity.LoginName.safeParse("two accounts").success).toBe(false)
  const password = " a sufficiently long password "
  expect(Identity.Password.parse(password)).toBe(password)
  expect(Identity.Password.safeParse("short").success).toBe(false)
})

test("mutation inputs reject client-supplied authority and require an explicit change", () => {
  expect(Identity.AccountChange.safeParse({ expectedRevision: 1 }).success).toBe(false)
  expect(Identity.AccountChange.parse({ expectedRevision: 1, role: "member" }).role).toBe("member")
  expect(Identity.ProjectChange.safeParse({ expectedRevision: 1 }).success).toBe(false)
  expect(Identity.ProjectChange.parse({ expectedRevision: 1, state: "archived" }).state).toBe("archived")
  for (const field of ["actor", "projectID", "creatorID", "orgID"]) {
    expect(Identity.ProjectCreate.safeParse({ name: "Project", [field]: "forged" }).success).toBe(false)
  }
  expect(Identity.Page.parse({ limit: "100" }).limit).toBe(100)
  expect(Identity.Page.safeParse({ limit: "101" }).success).toBe(false)
})
