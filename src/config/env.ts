import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),

  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().min(1),

  PAYPAL_BASE_URL: z
    .string()
    .url()
    .default("https://api-m.sandbox.paypal.com"),

  APP_RETURN_URL: z
    .string()
    .url()
    .default("http://localhost:3000/payment/success"),

  APP_CANCEL_URL: z
    .string()
    .url()
    .default("http://localhost:3000/payment/cancel"),
});

export const env = envSchema.parse(process.env);