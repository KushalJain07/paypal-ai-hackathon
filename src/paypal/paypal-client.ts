import { env } from "../config/env";

interface PayPalTokenResponse {
  access_token: string;
  expires_in: number;
}

interface PayPalLink {
  href: string;
  rel: string;
  method: string;
}

export interface PayPalOrder {
  id: string;
  status: string;
  links: PayPalLink[];
  purchase_units?: Array<{
    payments?: {
      captures?: Array<{
        id: string;
        status: string;
        amount: {
          currency_code: string;
          value: string;
        };
      }>;
    };
  }>;
}

interface CreateOrderInput {
  amount: string;
  currency: string;
  description: string;
}

export class PayPalClient {
  private accessToken?: string;
  private tokenExpiry = 0;

  private readonly baseUrl = env.PAYPAL_BASE_URL;

  private async getAccessToken(): Promise<string> {
    if (
      this.accessToken &&
      Date.now() < this.tokenExpiry
    ) {
      return this.accessToken;
    }

    const credentials = Buffer.from(
      `${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`
    ).toString("base64");

    const response = await fetch(
      `${this.baseUrl}/v1/oauth2/token`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      }
    );

    if (!response.ok) {
      throw new Error(
        `PayPal authentication failed: ${response.status}`
      );
    }

    const data = (await response.json()) as PayPalTokenResponse;

    this.accessToken = data.access_token;

    // Refresh one minute before expiration.
    this.tokenExpiry =
      Date.now() + (data.expires_in - 60) * 1000;

    return this.accessToken;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = await this.getAccessToken();

    const response = await fetch(
      `${this.baseUrl}${endpoint}`,
      {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();

      throw new Error(
        `PayPal API error ${response.status}: ${error}`
      );
    }

    return response.json() as Promise<T>;
  }

  async createOrder(
    input: CreateOrderInput
  ): Promise<PayPalOrder> {
    const amount = Number(input.amount);

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !/^\d+(\.\d{1,2})?$/.test(input.amount)
    ) {
      throw new Error("Invalid payment amount");
    }

    if (!/^[A-Z]{3}$/.test(input.currency)) {
      throw new Error("Invalid currency code");
    }

    const order = await this.request<PayPalOrder>(
      "/v2/checkout/orders",
      {
        method: "POST",
        headers: {
          "PayPal-Request-Id": crypto.randomUUID(),
        },
        body: JSON.stringify({
          intent: "CAPTURE",

          purchase_units: [
            {
              description: input.description,
              amount: {
                currency_code: input.currency,
                value: input.amount,
              },
            },
          ],

          application_context: {
            return_url: env.APP_RETURN_URL,
            cancel_url: env.APP_CANCEL_URL,
            user_action: "PAY_NOW",
          },
        }),
      }
    );

    return order;
  }

  async getOrder(orderId: string): Promise<PayPalOrder> {
    return this.request<PayPalOrder>(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}`
    );
  }

  async captureOrder(orderId: string): Promise<PayPalOrder> {
    return this.request<PayPalOrder>(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {
        method: "POST",
        headers: {
          "PayPal-Request-Id": crypto.randomUUID(),
        },
        body: JSON.stringify({}),
      }
    );
  }
}

export const paypalClient = new PayPalClient();