import { getStore } from "@netlify/blobs";
import {
  callPingupag,
  getWebhookUrl,
  jsonResponse,
  parseAllowedAmounts,
  readJsonBody,
  safePaymentResponse,
  updateOrderRecord,
  validateCreatePayload,
} from "./pix-core.mjs";

export function createPixCreateHandler({ store, env = process.env, fetchImpl = fetch }) {
  return async function pixCreateHandler(request) {
    if (request.method !== "POST") {
      return jsonResponse(405, { error: "Method not allowed." });
    }

    const parsedBody = await readJsonBody(request);
    if (parsedBody.error) {
      return jsonResponse(400, { error: parsedBody.error });
    }

    const { body } = parsedBody;
    let allowedAmounts;
    let postbackUrl;
    try {
      allowedAmounts = parseAllowedAmounts(env.PIX_ALLOWED_AMOUNTS_CENTS);
      postbackUrl = getWebhookUrl(env);
    } catch (error) {
      console.error("Pix configuration error.", { message: error.message });
      return jsonResponse(503, { error: "Pix payment is not configured." });
    }

    if (!env.PINGUPAG_API_KEY) {
      return jsonResponse(503, { error: "Pix payment is not configured." });
    }

    const validationError = validateCreatePayload(body, allowedAmounts);
    if (validationError) {
      return jsonResponse(400, { error: validationError });
    }

    const reservedAt = new Date().toISOString();
    const initialRecord = {
      reference: body.reference,
      amount: body.amount,
      status: "pending",
      providerTransactionId: null,
      createdAt: reservedAt,
      updatedAt: reservedAt,
      state: "creating",
    };

    const reservation = await store.setJSON(body.reference, initialRecord, { onlyIfNew: true });
    if (!reservation.modified) {
      const existing = await store.getWithMetadata(body.reference, { type: "json", consistency: "strong" });
      if (!existing) {
        return jsonResponse(503, { error: "Pix transaction could not be loaded." });
      }
      if (existing.data.amount !== body.amount) {
        return jsonResponse(409, { error: "Reference is already associated with a different payment." });
      }
      if (existing.data.state !== "created" || !existing.data.pixCopyPaste || !existing.data.qrCodeDataUrl) {
        return jsonResponse(409, { error: "Pix transaction is already being processed; do not retry with a new reference." });
      }
      return jsonResponse(200, safePaymentResponse(existing.data));
    }

    const gatewayPayload = {
      amount: body.amount,
      description: body.description.trim(),
      reference: body.reference,
      postback_url: postbackUrl,
      source: "api_externa",
      customer: {
        name: body.customer.name.trim(),
        email: body.customer.email.trim(),
        document: body.customer.document,
        phone: body.customer.phone,
      },
    };

    let gatewayResponse;
    try {
      gatewayResponse = await callPingupag("/gateway/v1/transaction", {
        apiKey: env.PINGUPAG_API_KEY,
        fetchImpl,
        method: "POST",
        body: gatewayPayload,
      });
    } catch (error) {
      await updateOrderRecord(store, body.reference, (current) => ({
        ...current,
        state: current.providerTransactionId ? "created" : "uncertain",
        updatedAt: new Date().toISOString(),
      }));
      return jsonResponse(502, { error: error.message });
    }

    const qrCodeDataUrl = gatewayResponse.qr_code_base64;
    const pixCopyPaste = gatewayResponse.qr_code;
    const gatewayAmount = gatewayResponse.amount;
    const providerTransactionId = gatewayResponse.transaction_id;
    const validQrCode =
      typeof qrCodeDataUrl === "string" &&
      /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(qrCodeDataUrl);

    if (
      gatewayResponse.status !== "success" ||
      typeof pixCopyPaste !== "string" ||
      pixCopyPaste.length === 0 ||
      !validQrCode ||
      !Number.isSafeInteger(gatewayAmount) ||
      gatewayAmount !== body.amount ||
      (typeof providerTransactionId !== "string" && !Number.isSafeInteger(providerTransactionId))
    ) {
      await updateOrderRecord(store, body.reference, (current) => ({
        ...current,
        providerTransactionId:
          current.providerTransactionId ??
          (typeof providerTransactionId === "string" || Number.isSafeInteger(providerTransactionId)
            ? String(providerTransactionId)
            : null),
        state:
          current.providerTransactionId ||
          typeof providerTransactionId === "string" ||
          Number.isSafeInteger(providerTransactionId)
            ? "created"
            : "uncertain",
        updatedAt: new Date().toISOString(),
      }));
      console.error("PinguPag returned an incomplete or mismatched Pix response.", {
        amountMatches: gatewayAmount === body.amount,
        hasTransactionId: providerTransactionId !== undefined && providerTransactionId !== null,
        hasCopyPaste: typeof pixCopyPaste === "string" && pixCopyPaste.length > 0,
        hasQrCode: validQrCode,
      });
      return jsonResponse(502, { error: "Payment provider returned an incomplete or mismatched Pix transaction." });
    }

    const completedRecord = await updateOrderRecord(store, body.reference, (current) => ({
      ...current,
      state: "created",
      providerTransactionId: String(providerTransactionId),
      pixCopyPaste,
      qrCodeDataUrl,
      updatedAt: new Date().toISOString(),
    }));
    if (!completedRecord) {
      return jsonResponse(503, { error: "Pix transaction could not be saved." });
    }

    return jsonResponse(201, safePaymentResponse(completedRecord));
  };
}

let handler;

export default async function pixCreate(request) {
  if (!handler) {
    handler = createPixCreateHandler({ store: getStore("pix-transactions") });
  }
  return handler(request);
}
