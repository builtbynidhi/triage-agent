/**
 * pnpm api:token --tenant tenant_a --role reviewer [--sub name] [--ttl 3600]
 * Prints a signed token for local use. There is no login endpoint: tokens come from whoever holds
 * JWT_SECRET (an identity provider in a real deployment).
 */
import { parseArgs } from "node:util";
import { ROLES, signToken, type Role } from "./auth.ts";
import { openRuntime } from "./runtime.ts";

const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    role: { type: "string", default: "agent" },
    sub: { type: "string", default: "dev" },
    ttl: { type: "string", default: "3600" },
  },
});
if (!values.tenant) throw new Error("--tenant is required (tenant_a or tenant_b)");
if (!(ROLES as readonly string[]).includes(values.role!))
  throw new Error(`--role must be one of ${ROLES.join(", ")}`);
const rt = openRuntime();
console.log(
  await signToken(
    rt.jwtSecret,
    { sub: values.sub!, tenantId: values.tenant, role: values.role as Role },
    { ttlSeconds: Number(values.ttl) },
  ),
);
