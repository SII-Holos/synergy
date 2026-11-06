import { Format } from "."
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { resolver } from "hono-openapi"

export function registerHttp() {
  Server.registerContributions(
    {
      routes: {
        "scoped-integrations": new Hono().get(
          "/formatter",
          describeRoute({
            summary: "Get formatter status",
            description: "Get formatter status",
            operationId: "formatter.status",
            responses: {
              200: {
                description: "Formatter status",
                content: {
                  "application/json": {
                    schema: resolver(Format.Status.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await Format.status())
          },
        ),
      },
      isScopeRequiredRoute: (pathname) => matchesPath(pathname, ["/formatter"]),
    },
    "formatter",
  )
}

function matchesPath(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
