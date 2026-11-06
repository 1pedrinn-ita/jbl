export const PINGUPAG_API_BASE_URL = "https://pagamento-processador.org.ua";
export const PIX_STORE_NAME = "pix-transactions";

const knownStatuses = new Set([
  "pending",
  "processing",
  "under_review",
  "approved",
  "failed",
  "refunded",
  "chargeback",
]);

export function jsonResponse(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function readJsonBody(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 16_384) {
    return { error: "Request body is too large." };
  }

  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return { error: "Content-Type must be application/json." };
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 16_384) {
    return { error: "Request body is too large." };
  }

  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { error: "Request body must be a JSON object." };
    }
    return { body };
  } catch {
    return { error: "Request body must be valid JSON." };
  }
}

export function parseAllowedAmounts(value) {
  if (!value) {
    throw new Error("PIX_ALLOWED_AMOUNTS_CENTS is not configured.");
  }

  const entries = value.split(",").map((entry) => entry.trim());
  const amounts = entries.map((entry) => Number(entry));
  if (
    entries.length === 0 ||
    amounts.some((amount, index) => !/^\d+$/.test(entries[index]) || !Number.isSafeInteger(amount) || amount < 100)
  ) {
    throw new Error("PIX_ALLOWED_AMOUNTS_CENTS must be a comma-separated list of integer cent amounts (minimum 100).");
  }

  return new Set(amounts);
}

export function validateCreatePayload(body, allowedAmounts) {
  if (!Number.isSafeInteger(body.amount) || !allowedAmounts.has(body.amount)) {
    return "The amount is not an allowed order amount.";
  }
  if (typeof body.reference !== "string" || !/^[A-Za-z0-9._:-]{32,128}$/.test(body.reference)) {
    return "Reference must be a unique, high-entropy identifier of 32 to 128 characters.";
  }
  if (typeof body.description !== "string" || body.description.trim().length === 0 || body.description.length > 255) {
    return "Description must contain between 1 and 255 characters.";
  }

  const customer = body.customer;
  if (!customer || typeof customer !== "object" || Array.isArray(customer)) {
    return "Customer information is required.";
  }
  if (typeof customer.name !== "string" || customer.name.trim().length === 0 || customer.name.length > 160) {
    return "Customer name is invalid.";
  }
  if (
    typeof customer.email !== "string" ||
    customer.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)
  ) {
    return "Customer email is invalid.";
  }
  if (typeof customer.document !== "string" || !/^(?:\d{11}|\d{14})$/.test(customer.document)) {
    return "Customer document must contain 11 or 14 digits.";
  }
  if (typeof customer.phone !== "string" || !/^\d{10,13}$/.test(customer.phone)) {
    return "Customer phone must contain 10 to 13 digits.";
  }

  return null;
}

export function isKnownStatus(status) {
  return knownStatuses.has(status);
}

export function normalizeProviderTransaction(transaction, expectedReference, expectedAmount) {
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
    return "Provider returned an invalid transaction.";
  }
  if (String(transaction.external_id ?? "") !== expectedReference) {
    return "Provider transaction reference does not match.";
  }
  if (!Number.isSafeInteger(transaction.amount) || transaction.amount !== expectedAmount) {
    return "Provider transaction amount does not match.";
  }
  if (!isKnownStatus(transaction.status)) {
    return "Provider returned an unknown transaction status.";
  }
  return null;
}

export async function updateOrderRecord(store, reference, update) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await store.getWithMetadata(reference, { type: "json", consistency: "strong" });
    if (!current) {
      return null;
    }

    const next = update(current.data);
    if (JSON.stringify(next) === JSON.stringify(current.data)) {
      return current.data;
    }

    const result = await store.setJSON(reference, next, { onlyIfMatch: current.etag });
    if (result.modified) {
      return next;
    }
  }

  throw new Error("Could not update the Pix transaction after concurrent changes.");
}

export function shouldApplyStatus(currentStatus, nextStatus) {
  if (currentStatus === nextStatus) {
    return false;
  }
  if (currentStatus === "chargeback" || currentStatus === "refunded") {
    return false;
  }
  if (
    currentStatus === "approved" &&
    ["pending", "processing", "under_review", "failed"].includes(nextStatus)
  ) {
    return false;
  }
  return true;
}

export async function callPingupag(path, { apiKey, fetchImpl = fetch, method = "GET", body } = {}) {
  const headers = {
    "X-API-Key": apiKey,
    accept: "application/json",
  };
  const options = {
    method,
    headers,
    signal: AbortSignal.timeout(12_000),
  };

  if (body !== undefined) {
    headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetchImpl(new URL(path, PINGUPAG_API_BASE_URL), options);
  } catch (error) {
    console.error("PinguPag request failed.", { errorName: error instanceof Error ? error.name : "UnknownError" });
    throw new Error("Payment provider is temporarily unavailable.");
  }

  if (!response.ok) {
    console.error("PinguPag returned an unsuccessful response.", { status: response.status });
    throw new Error("Payment provider rejected the request.");
  }

  let result;
  try {
    result = await response.json();
  } catch {
    console.error("PinguPag returned invalid JSON.", { status: response.status });
    throw new Error("Payment provider returned an invalid response.");
  }

  if (!result || typeof result !== "object") {
    throw new Error("Payment provider returned an invalid response.");
  }
  return result;
}

export function getWebhookUrl(env) {
  const configuredUrl = env.URL;
  if (!configuredUrl) {
    throw new Error("Netlify URL is not configured.");
  }

  let siteUrl;
  try {
    siteUrl = new URL(configuredUrl);
  } catch {
    throw new Error("Netlify URL is invalid.");
  }
  if (siteUrl.protocol !== "https:" || siteUrl.username || siteUrl.password) {
    throw new Error("Netlify URL must be an HTTPS URL.");
  }

  return new URL("/.netlify/functions/pix-webhook", siteUrl).toString();
}

export function safePaymentResponse(record) {
  return {
    reference: record.reference,
    status: record.status,
    amount: record.amount,
    pixCopyPaste: record.pixCopyPaste,
    qrCodeDataUrl: record.qrCodeDataUrl,
  };
}
