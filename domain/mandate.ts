import { z } from "zod";

const centsSchema = z.number().int().safe();
const nonNegativeCentsSchema = centsSchema.nonnegative();
const dateTimeSchema = z.string().datetime({ offset: true });

const mandateFieldsSchema = z
  .object({
    payee_email: z.string().trim().email(),
    per_payment_cap: centsSchema.positive(),
    total_cap: centsSchema.positive(),
    currency: z.literal("USD"),
    purpose: z.string().max(200),
    expires_at: dateTimeSchema,
    undo_window_seconds: z.number().int().min(10).max(3600),
  })
  .strict();

function addMandateCapValidation<
  T extends {
    per_payment_cap: number;
    total_cap: number;
  },
>(mandate: T, context: z.RefinementCtx): void {
  if (mandate.per_payment_cap > mandate.total_cap) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "per_payment_cap must not exceed total_cap",
      path: ["per_payment_cap"],
    });
  }
}

export const createMandateSchema = mandateFieldsSchema.superRefine(
  (mandate, context) => {
    addMandateCapValidation(mandate, context);

    if (Date.parse(mandate.expires_at) <= Date.now()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expires_at must be in the future",
        path: ["expires_at"],
      });
    }
  },
);

export const mandateSchema = mandateFieldsSchema
  .extend({
    id: z.string().min(1),
    version: z.number().int().positive(),
    spent_total: nonNegativeCentsSchema,
    reserved_total: nonNegativeCentsSchema,
    status: z.enum(["active", "expired", "revoked"]),
    signature: z.string().min(1),
    hash: z.string().min(1),
    created_at: dateTimeSchema,
  })
  .strict()
  .superRefine((mandate, context) => {
    addMandateCapValidation(mandate, context);

    if (
      mandate.spent_total + mandate.reserved_total >
      Number.MAX_SAFE_INTEGER
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "spent_total plus reserved_total must be a safe integer",
        path: ["reserved_total"],
      });
    }
  });

export type CreateMandate = z.infer<typeof createMandateSchema>;
export type Mandate = z.infer<typeof mandateSchema>;
