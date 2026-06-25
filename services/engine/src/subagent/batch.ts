import type { SubagentResult } from "./types.js";

export interface SubagentBatchOptions {
  concurrency?: number;
  timeoutMs?: number;
  retry?: number;
}

export class SubagentBatch {
  constructor(private dispatch: (input: string) => Promise<SubagentResult>) {}

  async run(inputs: string[], options: SubagentBatchOptions = {}): Promise<SubagentResult[]> {
    const concurrency = options.concurrency ?? 3;
    const retry = options.retry ?? 0;
    const results: SubagentResult[] = [];
    const queue = inputs.map((input, index) => ({ input, index }));

    async function worker(this: SubagentBatch): Promise<void> {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) return;
        let lastError: unknown;
        for (let attempt = 0; attempt <= retry; attempt++) {
          try {
            const result = await this.dispatch(item.input);
            results[item.index] = result;
            break;
          } catch (err) {
            lastError = err;
            if (attempt === retry) {
              results[item.index] = { taskId: `batch_${item.index}`, messages: [], error: String(lastError) };
            }
          }
        }
      }
    }

    const workers = Array.from({ length: concurrency }, () => worker.call(this));
    await Promise.all(workers);
    return results;
  }
}
