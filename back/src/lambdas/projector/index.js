import { createAppContext } from "../../shared/context.js";

let defaultCtxPromise = null;
async function getDefaultContext() {
  if (!defaultCtxPromise) defaultCtxPromise = createAppContext();
  return defaultCtxPromise;
}

export function createProjectorHandler(ctx) {
  return async function projectorHandler(event) {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    if (records.length === 0) return { batchItemFailures: [], eventsUpdated: 0 };

    const parsedMessages = [];
    const batchItemFailures = [];

    for (const record of records) {
      try {
        const body = typeof record.body === "string" ? JSON.parse(record.body) : record.body;
        if (body) parsedMessages.push(body);
      } catch {
        if (record.messageId) {
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }
    }

    if (parsedMessages.length > 0) {
      const res = await ctx.store.applyProjectionBatch(parsedMessages, ctx.now());
      return { batchItemFailures, eventsUpdated: res.eventsUpdated };
    }

    return { batchItemFailures, eventsUpdated: 0 };
  };
}

export const handler = async (event) => {
  const ctx = await getDefaultContext();
  return createProjectorHandler(ctx)(event);
};
