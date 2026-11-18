export const handler = async (event) => {
  const component = process.env.ORQUESTA_COMPONENT || "unknown";

  if (Array.isArray(event?.Records)) {
    return { batchItemFailures: [] };
  }

  const method = event?.requestContext?.http?.method || "GET";
  const path = event?.rawPath || "/";

  if (method === "GET" && path === "/health") {
    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
      body: JSON.stringify({
        status: "ok",
        service: "orquesta",
        component,
        environment: process.env.ENVIRONMENT || "lab",
        db_mode: process.env.DB_MODE || "rds_lab",
      }),
    };
  }

  return {
    statusCode: 501,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify({
      error: {
        code: "NOT_IMPLEMENTED",
        message: "Bootstrap placeholder Lambda ready for application deployment.",
        details: { component, method, path },
      },
    }),
  };
};
