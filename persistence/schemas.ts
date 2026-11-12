import { z } from "zod";
import { decisionPhaseSchema } from "../domain/decision.ts";
import { mandateSchema } from "../domain/mandate.ts";
import { paymentStatusSchema } from "../domain/payment.ts";

const jsonValueSchema: z.ZodType<
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const persistedMandateSchema = mandateSchema.superRefine(
  (mandate, context) => {
    if (!z.string().uuid().safeParse(mandate.id).success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "id must be a UUID for persistence.",
        path: ["id"],
      });
    }
  },
);

export const repositoryIdSchema = z.string().uuid();

export const reservePaymentInputSchema = z
  .object({
    id: z.string().uuid(),
    mandate_id: z.string().uuid(),
    invoice_id: z.string().trim().min(1).max(127),
    amount: z.number().int().positive().safe(),
    currency: z.literal("USD"),
    payee_email: z.string().trim().email(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const budgetHistoryQuerySchema = z
  .object({
    mandate_id: z.string().uuid(),
    excluding_payment_id: z.string().uuid().optional(),
  })
  .strict();

export const paymentEventSchema = z
  .object({
    id: z.number().int().positive().safe(),
    payment_id: z.string().uuid(),
    type: z.string().min(1),
    from_status: paymentStatusSchema.nullable(),
    to_status: paymentStatusSchema.nullable(),
    detail: z.record(z.string(), jsonValueSchema),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const appendPaymentEventSchema = paymentEventSchema.omit({ id: true });

export const decisionRecordSchema = z
  .object({
    id: z.number().int().positive().safe(),
    payment_id: z.string().uuid(),
    phase: decisionPhaseSchema,
    rule: z.enum(["R1", "R2", "R3", "R4", "R5"]),
    passed: z.boolean(),
    expected: z.record(z.string(), jsonValueSchema),
    actual: z.record(z.string(), jsonValueSchema),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

export type ReservePaymentInput = z.infer<typeof reservePaymentInputSchema>;
export type PaymentEvent = z.infer<typeof paymentEventSchema>;
export type AppendPaymentEvent = z.infer<typeof appendPaymentEventSchema>;
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;
