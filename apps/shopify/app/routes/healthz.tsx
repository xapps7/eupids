// Load balancer / uptime health check. Also confirms the database answers.
import prisma from "../db.server";

export const loader = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return new Response("ok", { headers: { "Cache-Control": "no-store" } });
  } catch {
    return new Response("db unavailable", { status: 503 });
  }
};
