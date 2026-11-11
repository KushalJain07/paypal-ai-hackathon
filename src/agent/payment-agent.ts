import { createAgent, tool } from "langchain";
import { ChatOpenRouter } from "@langchain/openrouter";
import { z } from "zod";

import { env } from "../config/env";
import { paypalClient } from "../paypal/paypal-client";

const createPaymentOrder = tool(
  async ({ amount, currency, description }) => {
    try {
      const order = await paypalClient.createOrder({
        amount,
        currency,
        description,
      });

      const approvalLink = order.links.find(
        (link) =>
          link.rel === "approve" ||
          link.rel === "payer-action"
      );

      if (!approvalLink) {
        throw new Error(
          "PayPal did not return an approval URL"
        );
      }

      return {
        success: true,
        orderId: order.id,
        status: order.status,
        approvalUrl: approvalLink.href,
        message: "Order created. Buyer approval is required.",
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown PayPal error",
      };
    }
  },
  {
    name: "create_paypal_order",

    description:
      "Creates a PayPal checkout order and returns the buyer approval URL. Does not charge the buyer.",

    schema: z.object({
      amount: z
        .string()
        .regex(/^\d+(\.\d{1,2})?$/)
        .describe("Payment amount, e.g. 50.00"),

      currency: z
        .string()
        .length(3)
        .transform((value) => value.toUpperCase())
        .describe("Three-letter currency code, e.g. USD"),

      description: z
        .string()
        .min(1)
        .max(127)
        .describe("Description of the purchase"),
    }),
  }
);

const getPaymentOrder = tool(
  async ({ orderId }) => {
    try {
      const order = await paypalClient.getOrder(orderId);

      return {
        success: true,
        orderId: order.id,
        status: order.status,
        captures:
          order.purchase_units?.flatMap(
            (unit) => unit.payments?.captures ?? []
          ) ?? [],
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown PayPal error",
      };
    }
  },
  {
    name: "get_paypal_order",

    description:
      "Retrieves a PayPal order and checks its current payment status using the PayPal API.",

    schema: z.object({
      orderId: z.string().min(1),
    }),
  }
);

const model = new ChatOpenRouter({
  apiKey: env.OPENROUTER_API_KEY,
  model: env.OPENROUTER_MODEL,
  temperature: 0,
});

export const paymentAgent = createAgent({
  model,

  tools: [
    createPaymentOrder,
    getPaymentOrder,
  ],

  systemPrompt: `
You are a PayPal payment assistant.

Your responsibilities:

1. Help users create PayPal payment orders.
2. Ask for missing payment details.
3. Never invent an amount, currency, or product description.
4. Use create_paypal_order to create an order.
5. Return the approval URL to the user.
6. Use get_paypal_order to retrieve payment status.
7. Never claim that an order is paid merely because it was created.
8. Only report a payment as completed when PayPal confirms
   the order and its capture status.
9. Never invent transaction IDs or payment confirmations.
10. Never attempt to capture an order yourself.

All payments must use the configured PayPal environment.
`,
});