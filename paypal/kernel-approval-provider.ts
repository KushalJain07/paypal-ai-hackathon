import Kernel, { NotFoundError } from "@onkernel/sdk";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { z } from "zod";
import { ManualApprovalProvider } from "./manual-approval-provider.ts";
import {
  PayPalProviderError,
  type ApprovalOrder,
  type ApprovalProvider,
  type ApprovalReady,
  type PaymentProvider,
} from "./payment-provider.ts";

const SANDBOX_API_URL = "https://api-m.sandbox.paypal.com";

const settingsSchema = z
  .object({
    apiKey: z.string().min(1),
    buyerEmail: z.string().email(),
    buyerPassword: z.string().min(1),
    profileName: z.string().min(1).max(255).regex(/^[A-Za-z0-9._-]+$/),
    paypalBaseUrl: z.literal(SANDBOX_API_URL),
    timeoutMs: z.number().int().positive().default(5 * 60 * 1000),
    intervalMs: z.number().int().positive().default(2_000),
    selectorTimeoutMs: z.number().int().positive().default(10_000),
    connectionTimeoutMs: z.number().int().positive().default(20_000),
    cleanupTimeoutMs: z.number().int().positive().default(5_000),
    fallbackManual: z.boolean().default(false),
  })
  .strict()
  .refine((settings) => settings.intervalMs <= settings.timeoutMs, {
    message: "intervalMs must not exceed timeoutMs",
  });

export class KernelApprovalError extends PayPalProviderError {
  constructor(code: "KERNEL_BROWSER_FAILURE" | "KERNEL_SELECTOR_FAILURE", cause?: unknown) {
    super(code, "kernelApproval");
    this.cause = cause;
  }
}

interface KernelSession {
  sessionId: string;
  cdpWsUrl: string;
  liveViewUrl?: string;
  replayUrl?: string;
}

interface KernelClient {
  ensureProfile(name: string): Promise<void>;
  createBrowser(input: {
    profileName: string;
    timeoutSeconds: number;
  }): Promise<KernelSession>;
  deleteBrowser(sessionId: string): Promise<void>;
}

interface BrowserConnector {
  connect(cdpWsUrl: string): Promise<Browser>;
}

interface KernelApprovalOptions {
  apiKey?: string;
  buyerEmail?: string;
  buyerPassword?: string;
  profileName?: string;
  paypalBaseUrl?: string;
  timeoutMs?: number;
  intervalMs?: number;
  selectorTimeoutMs?: number;
  connectionTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  fallbackManual?: boolean;
  kernelClient?: KernelClient;
  browserConnector?: BrowserConnector;
  print?: (message: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  manualApproval?: ApprovalProvider;
}

function isSandboxApprovalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["sandbox.paypal.com", "www.sandbox.paypal.com"].includes(url.hostname);
  } catch {
    return false;
  }
}

function makeKernelClient(apiKey: string): KernelClient {
  const kernel = new Kernel({ apiKey });
  return {
    async ensureProfile(name) {
      try {
        await kernel.profiles.retrieve(name);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        await kernel.profiles.create({ name });
      }
    },
    async createBrowser({ profileName, timeoutSeconds }) {
      const session = await kernel.browsers.create({
        stealth: true,
        profile: { name: profileName, save_changes: true },
        timeout_seconds: timeoutSeconds,
        start_replay: true,
      });
      return {
        sessionId: session.session_id,
        cdpWsUrl: session.cdp_ws_url,
        liveViewUrl: session.browser_live_view_url,
        replayUrl: session.replay?.replay_view_url,
      };
    },
    async deleteBrowser(sessionId) {
      await kernel.browsers.deleteByID(sessionId);
    },
  };
}

const playwrightConnector: BrowserConnector = {
  connect: (cdpWsUrl) => chromium.connectOverCDP(cdpWsUrl),
};

function safeDemoUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const name of [...url.searchParams.keys()]) {
      if (/token|jwt|key|secret|signature/i.test(name)) url.searchParams.delete(name);
    }
    return url.toString();
  } catch {
    return "[unavailable]";
  }
}

async function closeQuietly(browser: Browser | undefined, timeoutMs: number): Promise<void> {
  if (browser) {
    try {
      await withTimeout(browser.close(), timeoutMs);
    } catch {
      // Kernel session deletion below is the authoritative cleanup operation.
    }
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("KERNEL_CONNECTION_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class KernelApprovalProvider implements ApprovalProvider {
  private readonly paymentProvider: PaymentProvider;
  private readonly settings: z.infer<typeof settingsSchema>;
  private readonly kernelClient: KernelClient;
  private readonly browserConnector: BrowserConnector;
  private readonly print: (message: string) => void;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly manualApproval: ApprovalProvider;

  constructor(paymentProvider: PaymentProvider, options: KernelApprovalOptions = {}) {
    this.paymentProvider = paymentProvider;
    this.settings = settingsSchema.parse({
      apiKey: options.apiKey ?? process.env.KERNEL_API_KEY,
      buyerEmail: options.buyerEmail ?? process.env.SANDBOX_BUYER_EMAIL,
      buyerPassword: options.buyerPassword ?? process.env.SANDBOX_BUYER_PASSWORD,
      profileName: options.profileName ?? process.env.KERNEL_PROFILE_NAME,
      paypalBaseUrl: options.paypalBaseUrl ?? process.env.PAYPAL_BASE_URL ?? SANDBOX_API_URL,
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs,
      selectorTimeoutMs: options.selectorTimeoutMs,
      connectionTimeoutMs: options.connectionTimeoutMs,
      cleanupTimeoutMs: options.cleanupTimeoutMs,
      fallbackManual: options.fallbackManual ?? process.env.APPROVAL_FALLBACK_MANUAL === "true",
    });
    this.kernelClient = options.kernelClient ?? makeKernelClient(this.settings.apiKey);
    this.browserConnector = options.browserConnector ?? playwrightConnector;
    this.print = options.print ?? console.log;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
    this.manualApproval = options.manualApproval ?? new ManualApprovalProvider(paymentProvider, {
      timeoutMs: this.settings.timeoutMs,
      intervalMs: this.settings.intervalMs,
      print: this.print,
      sleep: this.sleep,
      now: this.now,
    });
  }

  async approve(order: ApprovalOrder): Promise<ApprovalReady> {
    const parsed = z.object({
      paymentId: z.string().min(1).max(256),
      paypalOrderId: z.string().min(1).max(256),
      approvalUrl: z.string().url().refine(isSandboxApprovalUrl),
    }).strict().safeParse(order);
    if (!parsed.success) throw new PayPalProviderError("INVALID_APPROVAL_ORDER", "kernelApproval");

    try {
      await this.approveInBrowser(parsed.data);
      return await this.pollForApproval(parsed.data);
    } catch (error) {
      if (this.settings.fallbackManual) {
        const code = error instanceof PayPalProviderError
          ? error.code
          : "KERNEL_BROWSER_FAILURE";
        this.print(`Kernel approval failed (${code}); switching to manual Sandbox approval.`);
        return this.manualApproval.approve(parsed.data);
      }
      if (error instanceof PayPalProviderError) throw error;
      const kernelError = error instanceof KernelApprovalError
        ? error
        : new KernelApprovalError("KERNEL_BROWSER_FAILURE", error);
      throw kernelError;
    }
  }

  private async approveInBrowser(order: ApprovalOrder): Promise<void> {
    let session: KernelSession | undefined;
    let browser: Browser | undefined;
    try {
      await this.kernelClient.ensureProfile(this.settings.profileName);
      session = await this.kernelClient.createBrowser({
        profileName: this.settings.profileName,
        timeoutSeconds: Math.max(10, Math.ceil(this.settings.timeoutMs / 1000)),
      });
      if (session.liveViewUrl) this.print(`Kernel live view: ${safeDemoUrl(session.liveViewUrl)}`);
      if (session.replayUrl) this.print(`Kernel replay: ${safeDemoUrl(session.replayUrl)}`);
      browser = await withTimeout(
        this.browserConnector.connect(session.cdpWsUrl),
        this.settings.connectionTimeoutMs,
      );
      const context = browser.contexts()[0];
      if (!context) throw new KernelApprovalError("KERNEL_BROWSER_FAILURE");
      const page = await this.getPage(context);
      await page.goto(order.approvalUrl, { waitUntil: "domcontentloaded", timeout: this.settings.selectorTimeoutMs });
      await this.signInIfNeeded(page);
      await this.advanceApproval(page);
    } catch (error) {
      if (error instanceof KernelApprovalError) throw error;
      throw new KernelApprovalError("KERNEL_BROWSER_FAILURE", error);
    } finally {
      await closeQuietly(browser, this.settings.cleanupTimeoutMs);
      if (session) {
        try {
          await withTimeout(
            this.kernelClient.deleteBrowser(session.sessionId),
            this.settings.cleanupTimeoutMs,
          );
        } catch {
          // Preserve the original approval failure; cleanup cannot expose session details.
        }
      }
    }
  }

  private async getPage(context: BrowserContext): Promise<Page> {
    return context.pages()[0] ?? context.newPage();
  }

  private async signInIfNeeded(page: Page): Promise<void> {
    const emailFilled = await this.tryFill(page, [
      () => page.getByLabel(/email/i),
      () => page.getByRole("textbox", { name: /email/i }),
      () => page.locator('input[type="email"]'),
    ], this.settings.buyerEmail);
    if (!emailFilled) return;
    await this.clickAny(page, [
      () => page.getByRole("button", { name: /next|continue/i }),
      () => page.getByRole("button", { name: /log in|sign in/i }),
    ]);
    const passwordFilled = await this.tryFill(page, [
      () => page.getByLabel(/password/i),
      () => page.getByRole("textbox", { name: /password/i }),
      () => page.locator('input[type="password"]'),
    ], this.settings.buyerPassword);
    if (passwordFilled) {
      await this.clickAny(page, [
        () => page.getByRole("button", { name: /log in|sign in|continue/i }),
        () => page.getByRole("button", { name: /next/i }),
      ]);
    }
  }

  private async advanceApproval(page: Page): Promise<void> {
    let clicked = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const didClick = await this.clickAny(page, [
        () => page.getByRole("button", { name: /continue|review|agree|accept/i }),
        () => page.getByRole("button", { name: /pay now|authorize|pay/i }),
      ]);
      clicked ||= didClick;
      if (didClick) await this.sleep(250);
    }
    if (!clicked) throw new KernelApprovalError("KERNEL_SELECTOR_FAILURE");
  }

  private async clickAny(page: Page, locators: Array<() => ReturnType<Page["getByRole"]>>): Promise<boolean> {
    for (const locator of locators) {
      try {
        await locator().click({ timeout: this.settings.selectorTimeoutMs });
        return true;
      } catch {
        // Checkout markup varies by PayPal session; try the next accessible selector.
      }
    }
    return false;
  }

  private async tryFill(page: Page, locators: Array<() => ReturnType<Page["getByRole"]>>, value: string): Promise<boolean> {
    for (const locator of locators) {
      try {
        await locator().fill(value, { timeout: this.settings.selectorTimeoutMs });
        return true;
      } catch {
        // A missing or hidden input means this session is already signed in or moved on.
      }
    }
    return false;
  }

  private async pollForApproval(order: ApprovalOrder): Promise<ApprovalReady> {
    const deadline = this.now() + this.settings.timeoutMs;
    while (true) {
      const snapshot = await this.paymentProvider.getOrder(order.paymentId, order.paypalOrderId);
      if (snapshot.status === "APPROVED") {
        return { paymentId: order.paymentId, paypalOrderId: snapshot.paypalOrderId, status: "APPROVED" };
      }
      if (snapshot.status === "VOIDED" || snapshot.status === "COMPLETED") {
        throw new PayPalProviderError("ORDER_NOT_APPROVABLE", "kernelApproval");
      }
      const remainingMs = deadline - this.now();
      if (remainingMs <= 0) throw new PayPalProviderError("APPROVAL_TIMEOUT", "kernelApproval");
      await this.sleep(Math.min(this.settings.intervalMs, remainingMs));
    }
  }
}
