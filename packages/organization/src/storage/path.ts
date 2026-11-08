export namespace OrganizationStoragePath {
  export const deployment = () => ["organization", "deployment"]
  export const info = () => ["organization", "info"]
  export const bootstrap = () => ["organization", "bootstrap"]
  export const account = (id: string) => ["organization", "accounts", id]
  export const accounts = () => ["organization", "accounts"]
  export const loginName = (hash: string) => ["organization", "login-names", hash]
  export const login = (hash: string) => ["organization", "logins", hash]
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
}
