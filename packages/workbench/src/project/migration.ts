import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ProjectDirectories } from "./directories"

export const projectMigrations = [
  {
    id: "20260929-project-directories",
    scope: "scope" as const,
    description: "Separate project folders from historical Worktrees without changing Scope identity",
    async up(progress: (current: number, total: number) => void) {
      const projects = await Scope.list()
      progress(0, projects.length)
      for (const [index, project] of projects.entries()) {
        await ProjectDirectories.migrateProject(project)
        progress(index + 1, projects.length)
      }
    },
  },
]

export function registerProjectMigrations() {
  MigrationRegistry.register("workbench-projects", projectMigrations)
}
