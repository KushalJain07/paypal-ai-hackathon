import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_MODEL: z.string().min(1).optional(),
  REWIND_API_BASE_URL: z
    .string()
    .url()
    .default("http://localhost:3000"),
});

export const env = envSchema.parse(process.env);

export function requireAgentConfiguration(): {
  apiKey: string;
  model: string;
} {
  const parsed = z.object({
    apiKey: z.string().min(1),
    model: z.string().min(1),
  }).safeParse({
    apiKey: env.OPENROUTER_API_KEY,
    model: env.OPENROUTER_MODEL,
  });
  if (!parsed.success) {
    throw new Error("AGENT_CONFIGURATION_REQUIRED");
  }
  return parsed.data;
}