# Netlify Pix functions

The Netlify Functions use the PinguPag API at `https://pagamento-processador.org.ua`.
They do not make real API requests during tests.

## Required Netlify environment

- `PINGUPAG_API_KEY`: PinguPag secret key. Set its value only in Netlify's protected
  environment-variable settings.
- `PIX_ALLOWED_AMOUNTS_CENTS`: comma-separated allowlist of integer amounts in
  centavos. Configure the exact amounts accepted by the checkout; the function
  rejects amounts outside this list.
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
not wired to these endpoints yet. The functions also cannot update an external
order system that is not present in the repository.
