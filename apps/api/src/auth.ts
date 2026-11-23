import type { TriageStore } from "@triage/data";
import type { NextFunction, Request, Response } from "express";
import { jwtVerify, SignJWT } from "jose";
import { problem } from "./problem.ts";

/**
 * JWT auth with two roles (spec, Phase 10).
 *
 *   agent     may submit tickets and read its own merchant's runs
 *   reviewer  may do all that, see the approval queue, and approve or reject
 *
 * Tokens are HS256, signed with JWT_SECRET, and must carry an expiry. The algorithm is pinned on
 * verify, so a token claiming `alg: none` or another algorithm is refused. The merchant comes from
 * the token's `tenant` claim and is never taken from a request body, a header or a URL.
 */
export const ROLES = ["agent", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export interface Principal {
  sub: string;
  tenantId: string;
  role: Role;
}

const ISSUER = "triage-agent";
const AUDIENCE = "triage-api";
const MIN_SECRET_CHARS = 32;
const key = (secret: string) => new TextEncoder().encode(secret);

export function assertSecret(secret: string | undefined): string {
  if (!secret || secret.length < MIN_SECRET_CHARS) {
    throw new Error(
      `JWT_SECRET must be set to at least ${MIN_SECRET_CHARS} characters (put it in .env; generate one with: openssl rand -hex 32).`,
    );
  }
  return secret;
}

export async function signToken(
  secret: string,
  who: Principal,
  opts: { ttlSeconds?: number; now?: number } = {},
): Promise<string> {
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  return new SignJWT({ tenant: who.tenantId, role: who.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(who.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (opts.ttlSeconds ?? 3600))
    .sign(key(secret));
}

export async function verifyToken(secret: string, token: string): Promise<Principal> {
  const { payload } = await jwtVerify(token, key(secret), {
    algorithms: ["HS256"],
    issuer: ISSUER,
    audience: AUDIENCE,
    requiredClaims: ["exp", "sub"],
  });
  const role = payload.role;
  if (typeof payload.sub !== "string" || typeof payload.tenant !== "string") {
    throw new Error("token has no subject or tenant");
  }
  if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) {
    throw new Error("token has no valid role");
  }
  return { sub: payload.sub, tenantId: payload.tenant, role: role as Role };
}

/** Rejects anything without a valid token for a merchant that exists. */
export function authenticate(secret: string, store: TriageStore) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const token = /^Bearer (.+)$/i.exec(header)?.[1];
    const reject = (detail: string) => {
      res.setHeader("WWW-Authenticate", 'Bearer realm="triage-api"');
      problem(res, 401, "Unauthorized", detail);
    };
    if (!token) return reject("Send an Authorization: Bearer <token> header.");
    try {
      const principal = await verifyToken(secret, token);
      if (!(await store.tenantExists(principal.tenantId))) return reject("Unknown merchant.");
      res.locals.principal = principal;
      next();
    } catch {
      // One message for every failure (expired, forged, wrong algorithm): no oracle for an attacker.
      reject("The token is missing, expired or invalid.");
    }
  };
}

/** Who is calling: set by `authenticate`, so only ever read after it has run. */
export const principalOf = (res: Response): Principal => res.locals.principal as Principal;

export function requireRole(...allowed: Role[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const who = res.locals.principal as Principal | undefined;
    if (!who || !allowed.includes(who.role)) {
      return problem(res, 403, "Forbidden", `This needs the ${allowed.join(" or ")} role.`);
    }
    next();
  };
}
