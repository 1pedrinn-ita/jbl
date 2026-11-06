import assert from "node:assert/strict";
import test from "node:test";
import {
  createPixReference,
  normalizeCheckoutCustomer,
  parseCheckoutAmount,
} from "../pix-checkout.js";

test("parses the displayed checkout total into integer centavos", () => {
  assert.equal(parseCheckoutAmount("Total R$ 1.234,56"), 123456);
});

test("rejects a missing or invalid displayed total", () => {
  assert.throws(() => parseCheckoutAmount(""), /total Pix/i);
  assert.throws(() => parseCheckoutAmount("R$ 0,50"), /inválido/i);
});

test("normalizes the checkout customer fields for the server API", () => {
  assert.deepEqual(
    normalizeCheckoutCustomer([" Cliente ", "cliente@example.invalid", "+55 (11) 99999-9999", "123.456.789-01"]),
    {
      name: "Cliente",
      email: "cliente@example.invalid",
      phone: "5511999999999",
      document: "12345678901",
    },
  );
});

test("rejects invalid required checkout customer fields", () => {
  assert.throws(
    () => normalizeCheckoutCustomer(["Cliente", "email-invalido", "11", "123"]),
    /Confira nome/i,
  );
});

test("uses a cryptographically generated UUID as the payment reference", () => {
  assert.equal(
    createPixReference({ randomUUID: () => "f1b6a36e-b015-4d51-9f48-8de91f2359a1" }),
    "f1b6a36e-b015-4d51-9f48-8de91f2359a1",
  );
});
