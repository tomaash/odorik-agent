import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify from "fastify";
import { port } from "./config.js";
import { dashboardHtml } from "./dashboard.js";
import { appRouter, createContext } from "./router.js";

const server = Fastify({ logger: true });

server.get("/health", async () => ({ ok: true, service: "api" }));
server.get("/", async (_request, reply) => {
  reply.type("text/html; charset=utf-8").send(dashboardHtml);
});

await server.register(fastifyTRPCPlugin, {
  prefix: "/trpc",
  trpcOptions: {
    router: appRouter,
    createContext,
  },
});

await server.listen({ port, host: "0.0.0.0" });
