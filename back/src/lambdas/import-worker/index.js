import { createAppContext, flushOutboxNow } from "../../shared/context.js";
import { parseGuestsCsv } from "../../shared/domain-helpers.js";
import { isAppError } from "../../shared/errors.js";

let defaultCtxPromise = null;
async function getDefaultContext() {
  if (!defaultCtxPromise) defaultCtxPromise = createAppContext();
  return defaultCtxPromise;
}

export function createImportWorkerHandler(ctx) {
  return async function importWorkerHandler(event) {
    const records = Array.isArray(event?.Records) ? event.Records : event ? [event] : [];
    const batchItemFailures = [];

    for (const record of records) {
      const messageId = record.messageId || null;
      try {
        const msg = typeof record.body === "string" ? JSON.parse(record.body) : record;
        const { import_id: importId, event_id: eventId, s3_key: s3Key } = msg;
        if (!importId || !eventId || !s3Key) {
          continue;
        }

        const obj = await ctx.objectStorage.getObject({
          bucket: ctx.importsBucket,
          key: s3Key,
        });
        if (!obj) {
          throw new Error(`CSV import object not found: ${s3Key}`);
        }

        const csvText = obj.body.toString("utf8");
        const parsedRows = parseGuestsCsv(csvText);

        await ctx.store.executeImportBatch({
          importId,
          eventId,
          parsedRows,
          qrSigner: ctx.qrSigner,
          objectStorage: ctx.objectStorage,
          assetsBucket: ctx.assetsBucket,
        });

        if (ctx.autoFlushOutbox) {
          await flushOutboxNow(ctx);
        }
      } catch (err) {
        if (isAppError(err) && err.code === "AFORO_EXCEDIDO") {
          // Falla determinista de negocio (AC-20): no reintentar en SQS
          continue;
        }
        if (messageId) {
          batchItemFailures.push({ itemIdentifier: messageId });
        } else {
          throw err;
        }
      }
    }

    return { batchItemFailures };
  };
}

export const handler = async (event) => {
  const ctx = await getDefaultContext();
  return createImportWorkerHandler(ctx)(event);
};
