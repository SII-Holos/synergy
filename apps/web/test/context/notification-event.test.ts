import { describe, expect, test } from "bun:test"
import { resolveNotificationEvent, resolveOrganizationNotice } from "../../src/context/notification-event"
const copy = {
  responseReady: "Response ready",
  sessionError: "Session error",
  errorFallback: "An error occurred",
}

test("a live shared organization notice targets its recipient space rather than its creator or a personal Scope", () => {
  const organization = {
    identity: { kind: "organization" as const, orgID: "org", accountID: "reader", deploymentIncarnation: "deployment" },
    projectID: "project",
    name: "Organization · Reader",
  }
  const notice = {
    noticeID: "00000000-0000-4000-8000-000000000001",
    kind: "completion" as const,
    sessionID: "session",
    binding: {
      schemaVersion: 1 as const,
      orgID: "org",
      projectID: "project",
      creatorID: "different-author",
      driverRuntimeID: "runtime",
      bindingEpoch: 1,
    },
    occurredAt: 1,
  }
  const result = resolveOrganizationNotice({ notice, organization, copy })
  expect(result).toMatchObject({ type: "turn-complete", sessionID: "session", organization, title: copy.responseReady })
  expect(result?.href).toBe("/organization/org/reader/deployment/projects/project/sessions/session")
  organization.identity.accountID = "later-account"
  expect(result?.organization?.identity.accountID).toBe("reader")
  expect(
    resolveOrganizationNotice({
      notice: { ...notice, binding: { ...notice.binding, projectID: "foreign" } },
      organization,
      copy,
    }),
  ).toBeUndefined()
})

describe("notification event semantics", () => {
  test("does not interpret lifecycle idle as a completed response", () => {
    expect(
      resolveNotificationEvent({
        directory: "/project",
        event: { type: "session.idle", properties: { sessionID: "ses_a" } },
        copy,
      }),
    ).toBeUndefined()
  })

  test("turn completion follows the durable completion notice event", () => {
    expect(
      resolveNotificationEvent({
        directory: "/project",
        event: { type: "session.completion", properties: { sessionID: "ses_a", unreadCount: 2 } },
        session: { id: "ses_a", title: "Build finished" },
        copy,
      }),
    ).toEqual({
      type: "turn-complete",
      sessionID: "ses_a",
      title: "Response ready",
      description: "Build finished",
      href: "/L3Byb2plY3Q/session/ses_a",
    })
  })

  test("does not raise global completion notifications for child sessions", () => {
    expect(
      resolveNotificationEvent({
        directory: "/project",
        event: { type: "session.completion", properties: { sessionID: "ses_child", unreadCount: 1 } },
        session: { id: "ses_child", title: "Child", parentID: "ses_parent" },
        copy,
      }),
    ).toBeUndefined()
  })

  test("keeps session errors distinct from completion", () => {
    expect(
      resolveNotificationEvent({
        directory: "/project",
        event: { type: "session.error", properties: { sessionID: "ses_a", error: "boom" } },
        session: { id: "ses_a", title: "Build" },
        copy,
      }),
    ).toEqual({
      type: "error",
      sessionID: "ses_a",
      error: "boom",
      title: "Session error",
      description: "Build",
      href: "/L3Byb2plY3Q/session/ses_a",
    })
  })

  test("a native organization completion keeps its full space identity instead of borrowing a personal Scope route", () => {
    const organization = {
      identity: {
        kind: "organization" as const,
        orgID: "org-a",
        accountID: "account-a",
        deploymentIncarnation: "deployment-a",
      },
      projectID: "project-a",
      name: "Team A",
    }
    const notification = resolveNotificationEvent({
      directory: "/personal-project",
      event: { type: "session.completion", properties: { sessionID: "session-a", unreadCount: 1 } },
      copy,
      ...{ organization },
    })
    expect(notification?.href).toBe("/organization/org-a/account-a/deployment-a/projects/project-a/sessions/session-a")
    expect(notification).toMatchObject({ organization, sessionID: "session-a" })
  })

  test("an organization error without an actual Session target cannot become a global organization notice", () => {
    expect(
      resolveNotificationEvent({
        organization: {
          identity: {
            kind: "organization",
            orgID: "org-a",
            accountID: "account-a",
            deploymentIncarnation: "deployment-a",
          },
          projectID: "project-a",
          name: "Team A",
        },
        event: { type: "session.error", properties: { error: "Global failure" } },
        copy,
      }),
    ).toBeUndefined()
  })

  test("a personal global error retains its original Scope recovery destination", () => {
    expect(
      resolveNotificationEvent({
        directory: "/project",
        event: { type: "session.error", properties: { error: "Global failure" } },
        copy,
      }),
    ).toMatchObject({ type: "error", href: "/L3Byb2plY3Q", description: "Global failure" })
  })
})
