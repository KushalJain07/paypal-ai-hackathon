import { z } from "zod";

const centsSchema = z.number().int().safe();
const dateTimeSchema = z.string().datetime({ offset: true });

export const paymentStatusSchema = z.enum([
  "requested",
  "authorized",
  "rejected",
  "held",
  "captured",
  "voided",
  "refunded",
  "failed",
]);

export const paymentSchema = z
  .object({
    id: z.string().min(1),
    mandate_id: z.string().min(1),
    invoice_id: z.string().min(1).nullable(),
    amount: centsSchema,
    currency: z.string().min(1),
    payee_email: z.string(),
    approval_url: z.string().url().nullable(),
    paypal_order_id: z.string().min(1).nullable(),
    authorization_id: z.string().min(1).nullable(),
    capture_id: z.string().min(1).nullable(),
    status: paymentStatusSchema,
    release_at: dateTimeSchema.nullable(),
    failure_reason: z.string().nullable(),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .strict();

export const observedPaymentSchema = z
  .object({
    payee_email: z.string(),
    amount: centsSchema,
    currency: z.string().min(1),
    invoice_id: z.string().nullable(),
    paypal_order_id: z.string().nullable(),
    authorization_id: z.string().nullable(),
    status: paymentStatusSchema,
  })
  .strict();

// Histories exclude the current payment; invoices are mandate-scoped and PayPal IDs are global.
export const budgetStateSchema = z
  .object({
    spent_total: centsSchema.nonnegative(),
    reserved_total: centsSchema.nonnegative(),
    used_invoice_ids: z.array(z.string().min(1)),
    processed_order_ids: z.array(z.string().min(1)),
    processed_authorization_ids: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((budget, context) => {
    if (budget.spent_total + budget.reserved_total > Number.MAX_SAFE_INTEGER) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "spent_total plus reserved_total must be a safe integer",
        path: ["reserved_total"],
      });
    }
  });

export type PaymentStatus = z.infer<typeof paymentStatusSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type ObservedPayment = z.infer<typeof observedPaymentSchema>;
export type BudgetState = z.infer<typeof budgetStateSchema>;
