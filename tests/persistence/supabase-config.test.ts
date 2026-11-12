import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSupabasePersistence } from "../../persistence/supabase.ts";
import { PersistenceError } from "../../persistence/repositories.ts";

describe("Supabase persistence configuration", () => {
  it("fails explicitly when server-side URL and service key are missing", () => {
    assert.throws(
      () => createSupabasePersistence({ NODE_ENV: "test" }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "CONFIGURATION_ERROR" &&
        !error.message.includes("service"),
    );
  });
});
