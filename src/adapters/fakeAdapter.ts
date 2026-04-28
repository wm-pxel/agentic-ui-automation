import type { TargetAdapter, TargetAdapterResult, TargetRunContext } from "./contract.js";

export class FakeAdapter implements TargetAdapter {
  readonly name = "fake";

  constructor(private readonly mode: "success" | "exception" = "success") {}

  async prepare(): Promise<void> {}

  async runRecord(context: TargetRunContext): Promise<TargetAdapterResult> {
    await context.audit.writeEvent({
      recordId: context.record.sourceRecordId,
      target: this.name,
      phase: "adapter",
      actionType: "inspect",
      rationale: "Fake adapter inspected the normalized intake record.",
      result: "inspect complete",
    });

    if (this.mode === "exception") {
      return {
        status: "exception",
        exception: {
          code: "verification_failed",
          severity: "error",
          message: "Fake adapter exception mode returned the implementation plan verification failure.",
          suggestedRemediation: "Review Task 5 fake adapter exception-mode plan text.",
        },
      };
    }

    return {
      status: "succeeded",
      targetRecordId: `fake-${context.record.sourceRecordId}`,
    };
  }

  async close(): Promise<void> {}
}
