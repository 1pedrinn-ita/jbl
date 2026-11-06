import assert from "node:assert/strict";
import test from "node:test";
import { createPixCreateHandler } from "../netlify/functions/pix-create.mjs";
import { createPixStatusHandler } from "../netlify/functions/pix-status.mjs";
import { createPixWebhookHandler } from "../netlify/functions/pix-webhook.mjs";
import { shouldApplyStatus } from "../netlify/functions/pix-core.mjs";

class MemoryStore {
  #entries = new Map();
  #version = 0;

  async setJSON(key, value, options = {}) {
    const current = this.#entries.get(key);
    if (options.onlyIfNew && current) {
      return { modified: false };
    }
    if (options.onlyIfMatch && current?.etag !== options.onlyIfMatch) {
      return { modified: false };
    }

    const etag = String(++this.#version);
    this.#entries.set(key, { data: structuredClone(value), etag });
    return { modified: true, etag };
  }

  async getWithMetadata(key) {
    const current = this.#entries.get(key);
    return current ? structuredClone(current) : null;
  }
}

const reference = "f1b6a36e-b015-4d51-9f48-8de91f2359a1";
const customer = {
  name: "Teste",
  email: "pix-test@example.invalid",
  document: "12345678901",
  phone: "11999999999",
};
const env = {
  PINGUPAG_API_KEY: "test-key-not-used-against-network",
  PIX_ALLOWED_AMOUNTS_CENTS: "3990",
  URL: "https://example.netlify.app",
};
const qrCode = "00020101021226850014br.gov.bcb.pix6304ABCD";
const qrCodeDataUrl = "data:image/png;base64,aGVsbG8=";

function request(url, method, body) {
  return new Request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("creates one Pix transaction with the documented request shape", async () => {
  const store = new MemoryStore();
  let gatewayCalls = 0;
  const fetchImpl = async (url, options) => {
    gatewayCalls += 1;
    assert.equal(url.href, "https://pagamento-processador.org.ua/gateway/v1/transaction");
    assert.equal(options.headers["X-API-Key"], env.PINGUPAG_API_KEY);
    const payload = JSON.parse(options.body);
    assert.equal(payload.amount, 3990);
    assert.equal(payload.reference, reference);
    assert.equal(payload.source, "api_externa");
    assert.equal(payload.postback_url, "https://example.netlify.app/.netlify/functions/pix-webhook");
    return Response.json({
      status: "success",
      transaction_id: 234,
      qr_code: qrCode,
      qr_code_base64: qrCodeDataUrl,
      amount: 3990,
    });
  };
  const handler = createPixCreateHandler({ store, env, fetchImpl });
  const body = { amount: 3990, reference, description: "Pagamento", customer };

  const created = await handler(request("https://example.netlify.app/.netlify/functions/pix-create", "POST", body));
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), {
    reference,
    status: "pending",
    amount: 3990,
    pixCopyPaste: qrCode,
    qrCodeDataUrl,
  });

  const duplicate = await handler(request("https://example.netlify.app/.netlify/functions/pix-create", "POST", body));
  assert.equal(duplicate.status, 200);
  assert.equal(gatewayCalls, 1);
});

test("rejects amounts that are not configured before contacting the provider", async () => {
  const handler = createPixCreateHandler({
    store: new MemoryStore(),
    env,
    fetchImpl: async () => {
      assert.fail("Provider must not be called for a disallowed amount.");
    },
  });
  const response = await handler(
    request(
      "https://example.netlify.app/.netlify/functions/pix-create",
      "POST",
      { amount: 1, reference, description: "Pagamento", customer },
    ),
  );
  assert.equal(response.status, 400);
});

test("keeps the provider transaction ID when its QR response is incomplete", async () => {
  const store = new MemoryStore();
  const handler = createPixCreateHandler({
    store,
    env,
    fetchImpl: async () =>
      Response.json({
        status: "success",
        transaction_id: 234,
        qr_code: qrCode,
        qr_code_base64: "invalid-image",
        amount: 3990,
      }),
  });
  const response = await handler(
    request(
      "https://example.netlify.app/.netlify/functions/pix-create",
      "POST",
      { amount: 3990, reference, description: "Pagamento", customer },
    ),
  );
  assert.equal(response.status, 502);
  const stored = await store.getWithMetadata(reference);
  assert.equal(stored.data.providerTransactionId, "234");
  assert.equal(stored.data.state, "created");
});

test("validates webhook state against the provider and ignores duplicate status changes", async () => {
  const store = new MemoryStore();
  await store.setJSON(reference, {
    reference,
    amount: 3990,
    status: "pending",
    state: "created",
    providerTransactionId: "234",
  });
  let providerCalls = 0;
  const handler = createPixWebhookHandler({
    store,
    env,
    fetchImpl: async (url, options) => {
      providerCalls += 1;
      assert.equal(options.headers["X-API-Key"], env.PINGUPAG_API_KEY);
      assert.match(url.href, /action=get_transaction&id=PINGUPAG_123$/);
      return Response.json({
        id: "PINGUPAG_123",
        external_id: reference,
        amount: 3990,
        status: "approved",
      });
    },
  });
  const event = {
    transaction_id: "PINGUPAG_123",
    external_id: reference,
    store_reference: reference,
    status: "pending",
    amount: 3990,
    payment_method: "pix",
  };

  const first = await handler(request("https://example.netlify.app/.netlify/functions/pix-webhook", "POST", event));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { received: true });

  const duplicate = await handler(request("https://example.netlify.app/.netlify/functions/pix-webhook", "POST", event));
  assert.equal(duplicate.status, 200);
  const stored = await store.getWithMetadata(reference);
  assert.equal(stored.data.status, "approved");
  assert.equal(providerCalls, 2);
});

test("rejects a webhook whose amount differs from the stored payment", async () => {
  const store = new MemoryStore();
  await store.setJSON(reference, {
    reference,
    amount: 3990,
    status: "pending",
    state: "created",
    providerTransactionId: "234",
  });
  const handler = createPixWebhookHandler({
    store,
    env,
    fetchImpl: async () => {
      assert.fail("Provider must not be queried for a mismatched webhook.");
    },
  });
  const response = await handler(
    request("https://example.netlify.app/.netlify/functions/pix-webhook", "POST", {
      transaction_id: "PINGUPAG_123",
      external_id: reference,
      status: "approved",
      amount: 1,
      payment_method: "pix",
    }),
  );
  assert.equal(response.status, 409);
});

test("records provider-confirmed failed status for declined, canceled, or expired payments", async () => {
  const store = new MemoryStore();
  await store.setJSON(reference, {
    reference,
    amount: 3990,
    status: "pending",
    state: "created",
    providerTransactionId: "234",
  });
  const handler = createPixWebhookHandler({
    store,
    env,
    fetchImpl: async () =>
      Response.json({
        id: "234",
        external_id: reference,
        amount: 3990,
        status: "failed",
      }),
  });

  const response = await handler(
    request("https://example.netlify.app/.netlify/functions/pix-webhook", "POST", {
      transaction_id: "234",
      external_id: reference,
      status: "failed",
      amount: 3990,
      payment_method: "pix",
    }),
  );
  assert.equal(response.status, 200);
  assert.equal((await store.getWithMetadata(reference)).data.status, "failed");
});

test("status endpoint queries the provider before returning an approved state", async () => {
  const store = new MemoryStore();
  await store.setJSON(reference, {
    reference,
    amount: 3990,
    status: "pending",
    state: "created",
    providerTransactionId: "234",
  });
  const handler = createPixStatusHandler({
    store,
    env,
    fetchImpl: async (url) => {
      assert.match(url.href, /action=get_transaction&id=234$/);
      return Response.json({
        id: "234",
        external_id: reference,
        amount: 3990,
        status: "approved",
      });
    },
  });

  const response = await handler(
    request(`https://example.netlify.app/.netlify/functions/pix-status?reference=${reference}`, "GET"),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "approved");
});

test("does not regress a confirmed payment to a pending state", () => {
  assert.equal(shouldApplyStatus("approved", "pending"), false);
  assert.equal(shouldApplyStatus("approved", "refunded"), true);
});
