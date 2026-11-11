import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";

const clientId = process.env.PAYPAL_CLIENT_ID;
const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  throw new Error("PayPal credentials are missing");
}

const paypalToolkit = new PayPalAgentToolkit({
  clientId,
  clientSecret,

  configuration: {
    context: {
      sandbox: true,
    },

    actions: {
      invoices: {
        create: true,
        list: true,
        send: true,
        sendReminder: true,
        cancel: true,
        delete: true,
        generateQRC: true,
        generateInvoiceNumber: true,
        search: true,
        update: true,
        cancelReminders: true,
        recordPayment: true,
        recordRefund: true,
        createConditionalRules: true,
      },

      products: {
        create: true,
        list: true,
        update: true,
      },

      subscriptionPlans: {
        create: true,
        list: true,
        show: true,
      },

      shipment: {
        create: true,
        show: true,
        cancel: true,
      },

      orders: {
        create: true,
        get: true,
      },

      disputes: {
        list: true,
        get: true,
      },
    },
  },
});

export { paypalToolkit };