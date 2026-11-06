# Netlify Pix functions

The Netlify Functions use the PinguPag API at `https://pagamento-processador.org.ua`.
They do not make real API requests during tests.

## Required Netlify environment

- `PINGUPAG_API_KEY`: PinguPag secret key. Set its value only in Netlify's protected
  environment-variable settings.
- `PIX_ALLOWED_AMOUNTS_CENTS`: comma-separated allowlist of integer amounts in
  centavos. The checkout client reads the currently displayed Pix total and
  submits it in centavos. Configure every exact total the checkout can produce
  (including quantity variants); the function rejects amounts outside this list.
- `URL`: Netlify's site URL, supplied by Netlify and used to form the webhook URL.

## Endpoints

- `POST /.netlify/functions/pix-create`: creates a Pix charge. The JSON body must
  include `amount` (centavos), `reference` (unique random identifier, 32-128
  allowed characters), `description`, and `customer` with `name`, `email`,
  numeric `document`, and numeric `phone`. The response contains `pixCopyPaste`
  and `qrCodeDataUrl`.
- `GET /.netlify/functions/pix-status?reference=...`: queries PinguPag server-side
  and returns the verified transaction status.
- `POST /.netlify/functions/pix-webhook`: receives PinguPag notifications. The
  function checks the stored reference and amount, queries the transaction using
  the protected API key, then stores only the status verified by PinguPag.

The create function sets `source: "api_externa"` as documented, so it does not
require `productHash`. Payment records are stored in the Netlify Blobs store
`pix-transactions`; personal customer fields are not persisted there.

The static website in this repository has no editable checkout source, so it is
compiled. `pix-checkout.js` is loaded by the existing checkout page and submits
its displayed total and customer fields to the functions without changing the
compiled application bundle. The functions store verified payment status in
Netlify Blobs; no separate order-management or fulfillment backend exists in
this repository.

The Netlify redirects preserve the former short path
`/lumina-pi-two-60.vercel.app/...` by forwarding it to the existing published
path under `/oferta/`. The current published site path remains available.
