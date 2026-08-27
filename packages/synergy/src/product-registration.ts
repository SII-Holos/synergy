/**
 * L4 product manifest: the single static list through which built-in product
 * domains attach to the harness core. Every real entry point loads this module
 * (main.ts for CLI commands, server/runtime.ts for the server and daemon
 * process), so product registrations are present before any core registry is
 * consumed.
 *
 * S1 scope: product-domain migrations. Later slices register continuation
 * policies, workflow prompt builders, workflow kinds, tools, and startup
 * contributions here.
 */
// Side-effect imports: register product-domain migrations in MigrationRegistry
import "./agenda/migration"
import "./blueprint/migration"
import "./browser/migration"
import "./holos/migration"
import "./lattice/migration"
import "./library/migration"
import "./note/migration"
import "./plugin/migration"
