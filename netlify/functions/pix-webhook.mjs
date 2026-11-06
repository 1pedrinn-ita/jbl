import { getStore } from "@netlify/blobs";
import {
  callPingupag,
  isKnownStatus,
  jsonResponse,
  normalizeProviderTransaction,
  readJsonBody,
  shouldApplyStatus,
  updateOrderRecord,
} from "./pix-core.mjs";

export function createPixWebhookHandler({ store, env = process.env, fetchImpl = fetch }) {
  return async function pixWebhookHandler(request) {
    if (request.method !== "POST") {
      return jsonResponse(405, { error: "Method not allowed." });
    }
    if (!env.PINGUPAG_API_KEY) {
      return jsonResponse(503, { error: "Pix payment is not configured." });
    }

    const parsedBody = await readJsonBody(request);
    if (parsedBody.error) {
      return jsonResponse(400, { error: parsedBody.error });
    }

    const event = parsedBody.body;
    if (
      typeof event.transaction_id !== "string" && !Number.isSafeInteger(event.transaction_id)
    ) {
      return jsonResponse(400, { error: "Webhook transaction ID is invalid." });
    }
    const reference = event.external_id;
    if (
      typeof reference !== "string" ||
      !/^[A-Za-z0-9._:-]{32,128}$/.test(reference) ||
      (event.store_reference !== undefined && event.store_reference !== reference) ||
      event.payment_method !== "pix" ||
      !isKnownStatus(event.status) ||
      !Number.isSafeInteger(event.amount)
    ) {
      return jsonResponse(400, { error: "Webhook transaction fields are invalid." });
    }

    const stored = await store.getWithMetadata(reference, { type: "json", consistency: "strong" });
    if (!stored) {
      return jsonResponse(404, { error: "Pix transaction was not found." });
    }
    if (event.amount !== stored.data.amount) {
      return jsonResponse(409, { error: "Webhook amount does not match the stored transaction." });
    }

    let transaction;
    try {
      const query = new URLSearchParams({
        action: "get_transaction",
        id: String(event.transaction_id),
      });
      transaction = await callPingupag(`/gateway/v1/query?${query}`, {
        apiKey: env.PINGUPAG_API_KEY,
        fetchImpl,
      });
    } catch (error) {
      return jsonResponse(502, { error: error.message });
    }

    const validationError = normalizeProviderTransaction(transaction, reference, stored.data.amount);
    if (validationError) {
      console.error("PinguPag webhook verification failed.", { reason: validationError });
      return jsonResponse(409, { error: "Payment provider transaction verification failed." });
    }

    const updated = await updateOrderRecord(store, reference, (current) => {
      if (!shouldApplyStatus(current.status, transaction.status)) {
        return current;
      }
      return {
        ...current,
        state: "created",
        status: transaction.status,
        providerTransactionId: current.providerTransactionId ?? String(event.transaction_id),
        updatedAt: new Date().toISOString(),
      };
    });
    if (!updated) {
      return jsonResponse(404, { error: "Pix transaction was not found." });
    }

    return jsonResponse(200, { received: true });
  };
}

let handler;

export default async function pixWebhook(request) {
  if (!handler) {
    handler = createPixWebhookHandler({ store: getStore("pix-transactions") });
  }
  return handler(request);
}
