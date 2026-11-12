import assert from "node:assert/strict";
import test from "node:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { KernelApprovalError, KernelApprovalProvider } from "../../paypal/kernel-approval-provider.ts";
import type { ApprovalProvider, PaymentProvider } from "../../paypal/payment-provider.ts";

const order = {
  paymentId: "payment-kernel-123",
  paypalOrderId: "order-kernel-123",
  approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=approval-secret",
};

function paymentProvider(statuses: Array<"CREATED" | "APPROVED">): PaymentProvider {
  return {
    async createOrder() { throw new Error("not used"); },
    async getOrder() {
      const status = statuses.shift() ?? "CREATED";
      return {
        paypalOrderId: order.paypalOrderId,
        status,
        observedPayment: {
          payee_email: "payee@example.com", amount: 500, currency: "USD",
          invoice_id: "invoice", paypal_order_id: order.paypalOrderId,
          authorization_id: null, status: "requested",
        },
      };
    },
    async authorizeOrder() { throw new Error("not used"); },
    async getAuthorization() { throw new Error("not used"); },
    async captureAuthorization() { throw new Error("not used"); },
    async voidAuthorization() { throw new Error("not used"); },
    async refundCapture() { throw new Error("not used"); },
  };
}

function fakeBrowser(mode: "signed-in" | "login" | "selector-failure") {
  const fills: string[] = [];
  let closed = 0;
  const locator = (canFill: boolean, canClick: boolean) => ({
    async fill(value: string) {
      if (!canFill) throw new Error("not visible");
      fills.push(value);
    },
    async click() {
      if (!canClick) throw new Error("not visible");
    },
  });
  const page = {
    async goto() {},
    getByLabel(name: RegExp) {
      return locator(mode === "login" && /email|password/i.test(name.source), false);
    },
    getByRole(role: string) {
      return locator(false, role === "button" && mode !== "selector-failure");
    },
    locator() { return locator(false, false); },
  } as unknown as Page;
  const context = { pages: () => [page], newPage: async () => page } as unknown as BrowserContext;
  const browser = {
    contexts: () => [context],
    async close() { closed += 1; },
  } as unknown as Browser;
  return { browser, fills, closed: () => closed };
}

function kernelClient(deleted: { value: number }) {
  return {
    async ensureProfile() {},
    async createBrowser() {
      return {
        sessionId: "kernel-session", cdpWsUrl: "wss://kernel.example/cdp-token",
        liveViewUrl: "https://kernel.example/live-view",
        replayUrl: "https://kernel.example/replay?jwt=replay-secret&replay_id=replay-123",
      };
    },
    async deleteBrowser() { deleted.value += 1; },
  };
}

function makeProvider(
  provider: PaymentProvider,
  browser: ReturnType<typeof fakeBrowser>,
  deleted: { value: number },
  logs: string[] = [],
  extra: {
    timeoutMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    connectionTimeoutMs?: number;
    cleanupTimeoutMs?: number;
    browserConnector?: { connect: () => Promise<Browser> };
    fallbackManual?: boolean;
    manualApproval?: ApprovalProvider;
  } = {},
) {
  return new KernelApprovalProvider(provider, {
    apiKey: "kernel-api-secret",
    buyerEmail: "buyer-secret@example.com",
    buyerPassword: "buyer-password-secret",
    profileName: "sandbox-buyer",
    paypalBaseUrl: "https://api-m.sandbox.paypal.com",
    kernelClient: kernelClient(deleted),
    browserConnector: extra.browserConnector ?? { connect: async () => browser.browser },
    timeoutMs: extra.timeoutMs ?? 100,
    intervalMs: 1,
    selectorTimeoutMs: 1,
    fallbackManual: extra.fallbackManual,
    connectionTimeoutMs: extra.connectionTimeoutMs,
    cleanupTimeoutMs: extra.cleanupTimeoutMs,
    manualApproval: extra.manualApproval,
    print: (line) => logs.push(line),
    sleep: extra.sleep ?? (async () => {}),
    now: extra.now ?? (() => 0),
  });
}

test("approves through Kernel and polls PayPal rather than checkout page text", async () => {
  const browser = fakeBrowser("signed-in");
  const deleted = { value: 0 };
  const approval = makeProvider(paymentProvider(["CREATED", "APPROVED"]), browser, deleted);
  const result = await approval.approve(order);
  assert.equal(result.status, "APPROVED");
  assert.equal(browser.closed(), 1);
  assert.equal(deleted.value, 1);
});

test("logs in only when the buyer login controls are present", async () => {
  const browser = fakeBrowser("login");
  const deleted = { value: 0 };
  const approval = makeProvider(paymentProvider(["APPROVED"]), browser, deleted);
  await approval.approve(order);
  assert.deepEqual(browser.fills, ["buyer-secret@example.com", "buyer-password-secret"]);
});

test("returns a typed error when no approval selector can be used", async () => {
  const browser = fakeBrowser("selector-failure");
  const deleted = { value: 0 };
  const approval = makeProvider(paymentProvider(["APPROVED"]), browser, deleted);
  await assert.rejects(() => approval.approve(order), (error: unknown) =>
    error instanceof KernelApprovalError && error.code === "KERNEL_SELECTOR_FAILURE",
  );
  assert.equal(browser.closed(), 1);
  assert.equal(deleted.value, 1);
});

test("falls back to manual approval after Kernel browser automation fails", async () => {
  const browser = fakeBrowser("selector-failure");
  const deleted = { value: 0 };
  let manualCalled = false;
  const approval = makeProvider(paymentProvider(["CREATED"]), browser, deleted, [], {
    fallbackManual: true,
    manualApproval: {
      async approve() {
        manualCalled = true;
        return {
          paymentId: order.paymentId,
          paypalOrderId: order.paypalOrderId,
          status: "APPROVED",
        };
      },
    },
  });

  const result = await approval.approve(order);
  assert.equal(result.status, "APPROVED");
  assert.equal(manualCalled, true);
});

test("times out a stalled CDP connection and still deletes the Kernel session", async () => {
  const browser = fakeBrowser("signed-in");
  const deleted = { value: 0 };
  const approval = makeProvider(paymentProvider(["APPROVED"]), browser, deleted, [], {
    connectionTimeoutMs: 1,
    browserConnector: { connect: () => new Promise<Browser>(() => {}) },
  });
  await assert.rejects(() => approval.approve(order), (error: unknown) =>
    error instanceof KernelApprovalError && error.code === "KERNEL_BROWSER_FAILURE",
  );
  assert.equal(deleted.value, 1);
});

test("returns the standard typed approval timeout after browser actions", async () => {
  const browser = fakeBrowser("signed-in");
  const deleted = { value: 0 };
  let time = 0;
  const approval = makeProvider(paymentProvider(["CREATED", "CREATED"]), browser, deleted, [], {
    timeoutMs: 1,
    now: () => time,
    sleep: async (milliseconds) => {
      if (milliseconds === 1) time += 1;
    },
  });
  await assert.rejects(() => approval.approve(order), (error: unknown) =>
    error instanceof KernelApprovalError === false &&
    typeof error === "object" && error !== null && (error as { code?: string }).code === "APPROVAL_TIMEOUT",
  );
});

test("never writes buyer secrets or the approval URL to Kernel logs", async () => {
  const browser = fakeBrowser("signed-in");
  const deleted = { value: 0 };
  const logs: string[] = [];
  const approval = makeProvider(paymentProvider(["APPROVED"]), browser, deleted, logs);
  await approval.approve(order);
  const output = logs.join("\n");
  assert.match(output, /Kernel live view: https:\/\/kernel\.example\/live-view/);
  assert.match(output, /Kernel replay: https:\/\/kernel\.example\/replay\?replay_id=replay-123/);
  assert.doesNotMatch(output, /kernel-api-secret|buyer-secret|buyer-password-secret|approval-secret|replay-secret/);
});
