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
