import { getAuth } from "firebase-admin/auth";
import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import { requireTeamMembership, type TeamRole } from "./tenancy.js";

export type Context = {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  photoURL: string;
};

export async function createContext({ req }: CreateHTTPContextOptions): Promise<Context> {
  const authorization = req.headers.authorization;
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  if (!token) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing authorization token" });
  }

  try {
    const decoded = await getAuth().verifyIdToken(token);
    return {
      uid: decoded.uid,
      email: decoded.email || "",
      emailVerified: decoded.email_verified === true,
      displayName: decoded.name || "",
      photoURL: decoded.picture || "",
    };
  } catch {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid authorization token" });
  }
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const signedInProcedure = t.procedure;

export const enabledProcedure = t.procedure.use(async ({ ctx, next }) => {
  const team = await requireTeamMembership(ctx.uid);
  return next({
    ctx: {
      ...ctx,
      companyId: team.companyId,
      teamName: team.teamName,
      role: team.role as TeamRole,
      access: {
        enabled: true,
        admin: team.role === "admin",
        companyId: team.companyId,
        role: team.role,
      },
    },
  });
});

export const adminProcedure = enabledProcedure.use(async ({ ctx, next }) => {
  if (ctx.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Administrator access required" });
  }
  return next({ ctx });
});
