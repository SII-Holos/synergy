export function clarusProjectKey(agentId: string, projectId: string): string {
  return `${encodeURIComponent(agentId)}:${encodeURIComponent(projectId)}`
}

export function clarusTaskKey(agentId: string, projectId: string, taskId: string): string {
  return `${clarusProjectKey(agentId, projectId)}:${encodeURIComponent(taskId)}`
}
