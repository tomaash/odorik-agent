import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import { z } from "zod";
import { secureEquals } from "./auth.js";
import { firestoreDatabaseId, geminiModel, projectId } from "./config.js";
import { db, toJsonSafe } from "./firestore.js";

type Context = {
  dashboardToken: string | undefined;
};

export function createContext({ req }: CreateFastifyContextOptions): Context {
  const value = req.headers["x-dashboard-token"];
  return { dashboardToken: Array.isArray(value) ? value[0] : value };
}

const t = initTRPC.context<Context>().create();

const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  const expected = process.env.DASHBOARD_TOKEN;
  if (!expected || !secureEquals(ctx.dashboardToken, expected)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid dashboard token" });
  }
  return next();
});

export const appRouter = t.router({
  system: t.router({
    health: protectedProcedure.query(async () => {
      await db().collection("calls").limit(1).get();
      return {
        ok: true,
        projectId: projectId(),
        databaseId: firestoreDatabaseId,
        databaseEdition: "Firestore Enterprise",
        model: geminiModel,
      };
    }),
  }),
  calls: t.router({
    list: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(50).default(20),
          })
          .optional(),
      )
      .query(async ({ input }) => {
        const snapshot = await db()
          .collection("calls")
          .limit(input?.limit ?? 20)
          .get();
        const calls: Array<Record<string, unknown> & { id: string }> = snapshot.docs
          .map((document) => ({
            id: document.id,
            ...(toJsonSafe(document.data()) as Record<string, unknown>),
          }));
        return calls
          .sort((left, right) =>
            String(right.uploadedAt || right.createdAt || "").localeCompare(
              String(left.uploadedAt || left.createdAt || ""),
            ),
          );
      }),
  }),
});

export type AppRouter = typeof appRouter;
