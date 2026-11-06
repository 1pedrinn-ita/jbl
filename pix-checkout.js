const checkoutSelector = ".checkout-screen";
const paymentButtonSelector = "button.checkout-button";
const customerInputCount = 4;
const pollIntervalMs = 10_000;
const maxPollDurationMs = 5 * 60 * 1000;

let customerValues = null;
let activeReference = null;
let requestInProgress = false;

export function parseCheckoutAmount(text) {
  const match = String(text).match(/R\$\s*([\d.]+,\d{2})/);
  if (!match) {
    throw new Error("Não foi possível identificar o total Pix do checkout.");
  }

  const normalized = match[1].replace(/\./g, "").replace(",", ".");
  const amount = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(amount) || amount < 100) {
    throw new Error("O total Pix do checkout é inválido.");
  }
  return amount;
}

export function normalizeCheckoutCustomer(values) {
  if (!Array.isArray(values) || values.length < customerInputCount) {
    throw new Error("Preencha os dados do cliente antes de gerar o Pix.");
  }

  const [nameValue, emailValue, phoneValue, documentValue] = values;
  const customer = {
    name: String(nameValue ?? "").trim(),
    email: String(emailValue ?? "").trim(),
    phone: String(phoneValue ?? "").replace(/\D/g, ""),
    document: String(documentValue ?? "").replace(/\D/g, ""),
  };

  if (
    !customer.name ||
    customer.name.length > 160 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email) ||
    customer.email.length > 254 ||
    !/^\d{10,13}$/.test(customer.phone) ||
    !/^(?:\d{11}|\d{14})$/.test(customer.document)
  ) {
    throw new Error("Confira nome, e-mail, telefone e documento antes de gerar o Pix.");
  }

  return customer;
}

export function createPixReference(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID !== "function") {
    throw new Error("Este navegador não oferece geração segura de referência Pix.");
  }
  return cryptoImpl.randomUUID();
}

function getScreen(button) {
  return button.closest(checkoutSelector);
}

function readPaymentCustomer(screen) {
  const inputs = [...screen.querySelectorAll("input")];
  if (inputs.length !== customerInputCount) {
    throw new Error("Não foi possível recuperar os dados do cliente do checkout.");
  }
  return normalizeCheckoutCustomer(inputs.map((input) => input.value));
}

function addStyles() {
  if (document.getElementById("pix-payment-styles")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "pix-payment-styles";
  style.textContent =
    ".pix-payment-result{margin:16px 0;padding:16px;border:1px solid #d5dbe3;border-radius:12px;background:#fff;color:#17212b;text-align:center}" +
    ".pix-payment-result img{display:block;width:min(240px,100%);height:auto;margin:12px auto}" +
    ".pix-payment-result textarea{box-sizing:border-box;width:100%;min-height:88px;margin:8px 0;padding:10px;resize:vertical}" +
    ".pix-payment-result button{min-height:44px;padding:10px 16px;cursor:pointer}" +
    ".pix-payment-result [role=status]{margin-top:10px}";
  document.head.append(style);
}

function createResultPanel(screen) {
  let panel = screen.querySelector(".pix-payment-result");
  if (panel) {
    panel.replaceChildren();
    return panel;
  }

  panel = document.createElement("section");
  panel.className = "pix-payment-result";
  panel.setAttribute("aria-live", "polite");
  panel.setAttribute("aria-label", "Resultado do pagamento Pix");

  const paymentOption = screen.querySelector(".pix-option");
  const card = paymentOption?.closest(".checkout-card");
  if (!card) {
    throw new Error("Não foi possível localizar a área técnica de pagamento Pix.");
  }
  card.append(panel);
  return panel;
}

function setStatus(panel, message) {
  let status = panel.querySelector("[role=status]");
  if (!status) {
    status = document.createElement("p");
    status.setAttribute("role", "status");
    panel.append(status);
  }
  status.textContent = message;
}

function renderPix(panel, payment) {
  const title = document.createElement("p");
  title.textContent = "Escaneie o QR Code ou copie o código Pix.";

  const qr = document.createElement("img");
  qr.src = payment.qrCodeDataUrl;
  qr.alt = "QR Code Pix";

  const code = document.createElement("textarea");
  code.readOnly = true;
  code.value = payment.pixCopyPaste;
  code.setAttribute("aria-label", "Código Pix Copia e Cola");

  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copiar código Pix";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(payment.pixCopyPaste);
      setStatus(panel, "Código Pix copiado.");
    } catch (error) {
      code.focus();
      code.select();
      setStatus(panel, "Não foi possível copiar automaticamente. Selecione e copie o código.");
      console.error("Could not copy Pix code.", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  });

  panel.append(title, qr, code, copy);
  setStatus(panel, "Aguardando confirmação do pagamento.");
}

async function pollPayment(screen, panel, reference) {
  const deadline = Date.now() + maxPollDurationMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    if (!screen.isConnected) {
      return;
    }

    try {
      const response = await fetch(
        `/.netlify/functions/pix-status?reference=${encodeURIComponent(reference)}`,
        { headers: { accept: "application/json" }, cache: "no-store" },
      );
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Não foi possível consultar o status do Pix.");
      }

      if (result.status === "approved") {
        setStatus(panel, "Pagamento confirmado.");
        return;
      }
      if (["failed", "refunded", "chargeback"].includes(result.status)) {
        setStatus(panel, "O pagamento não está aprovado. Consulte a loja para obter ajuda.");
        return;
      }
    } catch (error) {
      setStatus(panel, error instanceof Error ? error.message : "Não foi possível consultar o status do Pix.");
      return;
    }
  }

  if (screen.isConnected) {
    setStatus(panel, "A confirmação ainda está pendente. Atualize o status antes de tentar outro pagamento.");
  }
}

async function createPayment(button, screen) {
  if (requestInProgress) {
    return;
  }

  requestInProgress = true;
  button.disabled = true;
  let panel;

  try {
    panel = createResultPanel(screen);
    setStatus(panel, "Preparando a cobrança Pix.");
    const amount = parseCheckoutAmount(button.textContent);
    const customer = customerValues ?? readPaymentCustomer(screen);
    const reference = activeReference ?? createPixReference();
    activeReference = reference;

    const response = await fetch("/.netlify/functions/pix-create", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        amount,
        reference,
        description: "Pedido Pix",
        customer,
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Não foi possível gerar o Pix.");
    }
    if (
      result.reference !== reference ||
      result.amount !== amount ||
      typeof result.pixCopyPaste !== "string" ||
      typeof result.qrCodeDataUrl !== "string"
    ) {
      throw new Error("A resposta do servidor não corresponde à cobrança Pix solicitada.");
    }

    renderPix(panel, result);
    void pollPayment(screen, panel, reference);
  } catch (error) {
    if (panel) {
      setStatus(panel, error instanceof Error ? error.message : "Não foi possível gerar o Pix.");
    } else {
      console.error("Pix checkout could not be initialized.", error);
    }
  } finally {
    requestInProgress = false;
    button.disabled = false;
  }
}

export function initializePixCheckout(documentImpl = globalThis.document) {
  if (!documentImpl || documentImpl.documentElement.dataset.pixCheckoutInitialized === "true") {
    return;
  }
  documentImpl.documentElement.dataset.pixCheckoutInitialized = "true";
  addStyles();

  documentImpl.addEventListener(
    "click",
    (event) => {
      if (event.target.closest?.(".modal-buy")) {
        customerValues = null;
        activeReference = null;
        return;
      }

      const screen = event.target.closest?.(checkoutSelector);
      if (!screen) {
        return;
      }

      const button = event.target.closest?.("button");
      if (!screen.querySelector(".pix-option")) {
        if (button) {
          try {
            customerValues = readPaymentCustomer(screen);
          } catch {
            // Earlier checkout steps have different input sets; keep the validated customer.
          }
        }
        return;
      }

      if (!button?.matches(paymentButtonSelector)) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      void createPayment(button, screen);
    },
    true,
  );
}

if (typeof document !== "undefined") {
  initializePixCheckout(document);
}
