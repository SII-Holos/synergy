export namespace OrganizationStoragePath {
  export const deployment = () => ["organization", "deployment"]
  export const signingIdentity = () => ["organization", "signing-identity"]
  export const commandRequest = (subjectID: string, requestID: string) => [
    "organization",
    "command-requests",
    subjectID,
    requestID,
  ]
  export const commandAttempt = (attemptID: string) => ["organization", "command-attempts", attemptID]
  export const commandState = (sessionID: string) => ["organization", "command-states", sessionID]
  export const commandSkip = (attemptID: string, proofHash: string) => [
    "organization",
    "command-skips",
    attemptID,
    proofHash,
  ]
  export const sessionCommand = (sessionID: string, sequence: number) => [
    "organization",
    "session-commands",
    sessionID,
    String(sequence).padStart(16, "0"),
  ]
  export const requestAttempt = (subjectID: string, requestID: string, sequence: number) => [
    "organization",
    "request-attempts",
    subjectID,
    requestID,
    String(sequence).padStart(16, "0"),
  ]
  export const info = () => ["organization", "info"]
  export const bootstrap = () => ["organization", "bootstrap"]
  export const account = (id: string) => ["organization", "accounts", id]
  export const accounts = () => ["organization", "accounts"]
  export const loginName = (hash: string) => ["organization", "login-names", hash]
  export const login = (hash: string) => ["organization", "logins", hash]
  export const authorizationCode = (hash: string) => ["organization", "authorization-codes", hash]
  export const clientGrant = (id: string) => ["organization", "client-grants", id]
  export const clientAccess = (hash: string) => ["organization", "client-access", hash]
  export const clientRefresh = (hash: string) => ["organization", "client-refresh", hash]
  export const invite = (hash: string) => ["organization", "invites", hash]
  export const reset = (hash: string) => ["organization", "resets", hash]
  export const runtimes = () => ["organization", "runtimes"]
  export const runtime = (id: string) => [...runtimes(), id]
  export const runtimeConnection = (id: string) => ["organization", "runtime-connections", id]
  export const runtimeDevice = (accountID: string, deviceID: string) => [
    "organization",
    "runtime-devices",
    accountID,
    deviceID,
  ]
  export const accountRuntimes = (accountID: string) => ["organization", "account-runtimes", accountID]
  export const accountRuntime = (accountID: string, runtimeID: string) => [...accountRuntimes(accountID), runtimeID]
  export const runtimeTicket = (hash: string) => ["organization", "runtime-tickets", hash]
  export const projects = () => ["organization", "projects"]
  export const project = (id: string) => [...projects(), id]
  export const projectMember = (projectID: string, accountID: string) => [
    "organization",
    "project-members",
    projectID,
    accountID,
  ]
  export const accessibleProjects = (accountID: string) => ["organization", "project-access", accountID]
  export const projectAccess = (accountID: string, projectID: string) => [...accessibleProjects(accountID), projectID]
  export const sessions = () => ["organization", "sessions"]
  export const session = (id: string) => [...sessions(), id]
  export const creatorSessions = (projectID: string, creatorID: string) => [
    "organization",
    "session-creators",
    projectID,
    creatorID,
  ]
  export const creatorSession = (projectID: string, creatorID: string, sessionID: string) => [
    ...creatorSessions(projectID, creatorID),
    sessionID,
  ]
  export const sessionVisibility = (state: "private" | "shared", projectID?: string) => [
    "organization",
    "session-visibility",
    state,
    ...(projectID ? [projectID] : []),
  ]
  export const visibleSession = (state: "private" | "shared", projectID: string, sessionID: string) => [
    ...sessionVisibility(state, projectID),
    sessionID,
  ]
}
