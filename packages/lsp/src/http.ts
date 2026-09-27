import { LSP } from "."
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { resolver } from "hono-openapi"

export function registerHttp() {
  Server.registerContributions(
    {
      routes: {
        "scoped-integrations": new Hono().get(
          "/lsp",
          describeRoute({
            summary: "Get LSP status",
            description: "Get LSP server status",
            operationId: "lsp.status",
            responses: {
              200: {
                description: "LSP server status",
                content: {
                  "application/json": {
                    schema: resolver(LSP.Status.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await LSP.status())
          },
        ),
      },
      bootstrap: { lsp: { schema: LSP.Status.array(), load: () => LSP.status(), projectOnly: true } },
      isScopeRequiredRoute: (pathname) => matchesPath(pathname, ["/lsp"]),
    },
    "lsp",
  )
}

function matchesPath(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
