import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IllegalPaymentTransitionError,
  transitionPaymentStatus,
} from "../../domain/state-machine.ts";

describe("payment state machine", () => {
  it("allows exactly the transitions defined by the SRS", () => {
    const legalTransitions = [
      ["requested", "authorized"],
      ["requested", "failed"],
      ["authorized", "held"],
      ["authorized", "rejected"],
      ["authorized", "failed"],
      ["held", "captured"],
      ["held", "voided"],
      ["held", "failed"],
      ["captured", "refunded"],
    ] as const;

    for (const [from, to] of legalTransitions) {
      assert.equal(transitionPaymentStatus(from, to), to);
    }
  });

  it("throws a typed error for illegal transitions, including terminal states", () => {
    assert.throws(
      () => transitionPaymentStatus("requested", "held"),
      IllegalPaymentTransitionError,
    );
    assert.throws(
      () => transitionPaymentStatus("captured", "voided"),
      IllegalPaymentTransitionError,
    );
    assert.throws(
      () => transitionPaymentStatus("refunded", "captured"),
      IllegalPaymentTransitionError,
    );
  });
});
