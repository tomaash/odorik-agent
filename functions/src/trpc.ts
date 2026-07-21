import { getAuth } from "firebase-admin/auth";
import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import { db } from "./firestore.js";

export type AccessRecord = {
  email: string;
  displayName: string;
  photoURL: string;
  enabled: boolean;
  admin: boolean;
};

export type Context = {
  uid: string;
  email: string;
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
  const access = await db.doc(`access/${ctx.uid}`).get();
  if (!access.exists || access.data()?.enabled !== true) {
    throw new TRPCError({ code: "FORBIDDEN", message: "PENDING_APPROVAL" });
  }
  return next({
    ctx: {
      ...ctx,
      access: access.data() as AccessRecord,
    },
  });
});
