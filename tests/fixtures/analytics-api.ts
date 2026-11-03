// Local SQL API contract fixture. It is a separate test Worker, never imported
// by the production bundle. Native AE persistence is verified after deployment.
export default {
  async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      request.headers.get("Authorization") !== "Bearer integration-query-token"
    ) {
      console.error("SQL fixture: unauthorized request");
      return new Response("Unauthorized", { status: 403 });
    }
    const sql = await request.text();
    if (
      sql.length > 4096 ||
      !sql.includes("FROM integration_metrics") ||
      !sql.includes("_sample_interval") ||
      !sql.endsWith("FORMAT JSON")
    ) {
      console.error("SQL fixture: invalid contract");
      return new Response("Invalid SQL contract", { status: 400 });
    }
    const server = sql.match(/index1 = '([a-z0-9-]{1,64})'/)?.[1];
    const step = Number(sql.match(/intDiv\(double5, (\d+)\)/)?.[1]);
    if (!server || ![300, 900].includes(step)) {
      console.error("SQL fixture: invalid query");
      return new Response("Invalid query", { status: 400 });
    }
    return Response.json({
      data: [
        {
          time: Math.floor(Date.now() / 1000 / step) * step,
          cpu: 32,
          memory: 40,
          disk: 30,
        },
      ],
    });
  },
} satisfies ExportedHandler;
