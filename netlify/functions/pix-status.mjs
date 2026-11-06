import { getStore } from "@netlify/blobs";
import {
  callPingupag,
  jsonResponse,
  normalizeProviderTransaction,
  safePaymentResponse,
  shouldApplyStatus,
  updateOrderRecord,
} from "./pix-core.mjs";

export function createPixStatusHandler({ store, env = process.env, fetchImpl = fetch }) {
  return async function pixStatusHandler(request) {
    if (request.method !== "GET") {
      return jsonResponse(405, { error: "Method not allowed." });
    }
    if (!env.PINGUPAG_API_KEY) {
      return jsonResponse(503, { error: "Pix payment is not configured." });
    }

    const url = new URL(request.url);
    const reference = url.searchParams.get("reference");
    if (!reference || !/^[A-Za-z0-9._:-]{32,128}$/.test(reference)) {
      return jsonResponse(400, { error: "A valid reference is required." });
    }

    const stored = await store.getWithMetadata(reference, { type: "json", consistency: "strong" });
    if (!stored) {
      return jsonResponse(404, { error: "Pix transaction was not found." });
    }

    if (!stored.data.providerTransactionId) {
      return jsonResponse(200, safePaymentResponse(stored.data));
    }

    let transaction;
    try {
      const query = new URLSearchParams({
        action: "get_transaction",
        id: stored.data.providerTransactionId,
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
      console.error("PinguPag transaction verification failed.", { reason: validationError });
      return jsonResponse(502, { error: "Payment provider transaction verification failed." });
    }

    const updated = await updateOrderRecord(store, reference, (current) => {
      if (!shouldApplyStatus(current.status, transaction.status)) {
        return current;
      }
      return {
        ...current,
        status: transaction.status,
        updatedAt: new Date().toISOString(),
      };
    });
    if (!updated) {
      return jsonResponse(404, { error: "Pix transaction was not found." });
    }

    return jsonResponse(200, safePaymentResponse(updated));
  };
}

let handler;

export default async function pixStatus(request) {
  if (!handler) {
    handler = createPixStatusHandler({ store: getStore("pix-transactions") });
  }
  return handler(request);
}
