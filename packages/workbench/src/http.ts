import { Vcs } from "./project/vcs"
import { GitRoute } from "./project/routes/git"
import { StatsRoute } from "./stats/routes/stats"
import { PerformanceRoute } from "./performance/routes/performance-route"
import { PushRoute } from "./push/routes/push"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { resolver } from "hono-openapi"

export function registerHttp() {
  Server.registerContributions(
    {
      routes: {
        "global-tools": new Hono().route("/global/git", GitRoute()).route("/global/stats", StatsRoute()),
        "global-performance": new Hono().route("/global", PerformanceRoute()),
        "global-services": new Hono().route("/push", PushRoute()),
        "scoped-version-control": new Hono().get(
          "/vcs",
          describeRoute({
            summary: "Get VCS info",
            description:
              "Retrieve version control system (VCS) information for the current project, such as git branch.",
            operationId: "vcs.get",
            responses: {
              200: {
                description: "VCS info",
                content: {
                  "application/json": {
                    schema: resolver(Vcs.Info),
                  },
                },
              },
            },
          }),
          async (c) => {
            const branch = await Vcs.branch()
            return c.json({
              branch,
            })
          },
        ),
      },
      bootstrap: {
        vcs: {
          schema: Vcs.Info,
          load: () => Vcs.branch().then((branch) => ({ branch: branch ?? "" })),
          projectOnly: true,
        },
      },
      isScopeRequiredRoute: (pathname) => matchesPath(pathname, ["/vcs"]),
    },
    "workbench",
  )
}

function matchesPath(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
