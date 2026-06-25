import type { Tool, ToolAccess } from "../../tools/types.js";

export interface ScheduledCall {
  tool: Tool;
  toolCallId: string;
  args: unknown;
}

export class ToolScheduler {
  schedule(calls: ScheduledCall[]): ScheduledCall[][] {
    const batches: ScheduledCall[][] = [];
    for (const call of calls) {
      let placed = false;
      for (const batch of batches) {
        if (!this.conflicts(call, batch)) {
          batch.push(call);
          placed = true;
          break;
        }
      }
      if (!placed) {
        batches.push([call]);
      }
    }
    return batches;
  }

  private conflicts(call: ScheduledCall, batch: ScheduledCall[]): boolean {
    for (const other of batch) {
      if (this.accessesConflict(call.tool.accesses, other.tool.accesses)) {
        return true;
      }
    }
    return false;
  }

  private accessesConflict(a: ToolAccess[], b: ToolAccess[]): boolean {
    for (const accessA of a) {
      for (const accessB of b) {
        if (accessA.resource !== accessB.resource) continue;
        if (accessA.action !== accessB.action) continue;
        if (accessA.path && accessB.path && accessA.path !== accessB.path) continue;
        return true;
      }
    }
    return false;
  }
}
