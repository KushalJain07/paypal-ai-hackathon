import { z } from "zod";

export const guardianRules = ["R1", "R2", "R3", "R4", "R5"] as const;
export const decisionPhaseSchema = z.enum(["preflight", "authorized"]);
export type DecisionPhase = z.infer<typeof decisionPhaseSchema>;

const evidenceValueSchema = z.union([
  z.string(),
  z.number().int().safe(),
  z.boolean(),
  z.null(),
]);

export const ruleResultSchema = z
  .object({
    rule: z.enum(guardianRules),
    passed: z.boolean(),
    expected: z.record(z.string(), evidenceValueSchema),
    actual: z.record(z.string(), evidenceValueSchema),
  })
  .strict();

export const decisionSchema = z
  .object({
    phase: decisionPhaseSchema,
    passed: z.boolean(),
    results: z.array(ruleResultSchema).length(guardianRules.length),
  })
  .strict()
  .superRefine((decision, context) => {
    decision.results.forEach((result, index) => {
      if (result.rule !== guardianRules[index]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Expected ${guardianRules[index]} at position ${index + 1}`,
          path: ["results", index, "rule"],
        });
      }
    });

    if (decision.passed !== decision.results.every((result) => result.passed)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Decision verdict must match the results of all Guardian rules",
        path: ["passed"],
      });
    }
  });

export type GuardianRule = (typeof guardianRules)[number];
export type RuleEvidence = z.infer<typeof evidenceValueSchema>;
export type RuleResult = z.infer<typeof ruleResultSchema>;
export type Decision = z.infer<typeof decisionSchema>;
