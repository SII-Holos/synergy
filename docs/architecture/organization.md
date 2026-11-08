# Organization service

The organization service and Agent Runtime have separate process and storage ownership. `packages/organization-protocol` defines strict wire schemas. `packages/organization` opens an explicit isolated Home, owns its process lock and SQL namespace, registers its domain migrations and serves its Hono application. It does not open an Agent Runtime, choose model providers or recover Session execution.

The deployment record contains a stable organization ID, a deployment incarnation and a schema version. The owning migration creates it through the central runner; restarts preserve both identities. Failed startup closes the acquired store and releases only the service's own lock. Shutdown refuses new operations and drains admitted work before closing storage.

The independent organization OpenAPI document generates the SDK's `./organization` entry. Runtime APIs retain their existing client. Wire schemas reject unknown fields and protocol versions. Build versions are diagnostic labels, so an otherwise compatible bridge message is not rejected solely because it comes from another product release.

The organization component starts experimental and disabled. Its declaration follows [feature lifecycle](feature-lifecycle.md). The [storage architecture](agent-storage.md) remains authoritative for transactions, commit uncertainty, migrations and PostgreSQL fencing.
