import "dotenv/config";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const smokeResultSchema = z
  .object({
    payment_readback: z.literal(true),
    duplicate_invoice_rejected: z.literal(true),
    over_budget_rejected: z.literal(true),
    cleanup: z.literal("transaction_rolled_back"),
  })
  .strict();

const configSchema = z.object({
  url: z.string().url(),
  serviceRoleKey: z.string().min(1),
});

function isAuthOrPermissionError(code?: string): boolean {
  return (
    code === "401" ||
    code === "403" ||
    code === "42501" ||
    code === "PGRST301" ||
    code === "PGRST302"
  );
}

async function main(): Promise<void> {
  const config = configSchema.safeParse({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  if (!config.success) {
    console.error(
      "Missing or invalid SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY. Values are not printed.",
    );
    process.exitCode = 1;
    return;
  }

  const client = createClient(config.data.url, config.data.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  const { data, error } = await client.rpc("smoke_test_reservation");
  if (error) {
    if (isAuthOrPermissionError(error.code)) {
      console.error(
        `Supabase authorization failed (code ${error.code ?? "unknown"}). Check that SUPABASE_SERVICE_ROLE_KEY is the project's server-side service_role key, not the anon/public key.`,
      );
    } else if (
      error.code === "PGRST125" ||
      error.code === "PGRST202" ||
      error.code === "PGRST205"
    ) {
      console.error(
        `Smoke RPC is unavailable (code ${error.code}). Apply supabase/migrations/202611120002_smoke_test_reservation.sql in the Supabase SQL Editor, then retry. No smoke-test rows were created.`,
      );
    } else {
      console.error(
        `Supabase smoke test failed (code ${error.code ?? "unknown"}). No credential values or raw response body were printed.`,
      );
    }
    process.exitCode = 1;
    return;
  }

  const result = smokeResultSchema.safeParse(data);
  if (!result.success) {
    console.error(
      "Smoke RPC returned an unexpected result shape. No response contents were printed.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("Supabase persistence smoke test passed:");
  console.log("- mandate created inside a transaction");
  console.log("- payment reserved and read back");
  console.log("- duplicate invoice reservation rejected");
  console.log("- over-budget reservation rejected");
  console.log("- test transaction rolled back; no smoke rows retained");
}

main().catch((error: unknown) => {
  const code =
    error instanceof TypeError ? "NETWORK_ERROR" : "UNEXPECTED_ERROR";
  console.error(`Supabase smoke test stopped (${code}). No secrets were printed.`);
  process.exitCode = 1;
});
