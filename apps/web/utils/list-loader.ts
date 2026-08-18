import { ref, type Ref } from "vue";

// store 列表加载模板（D2 收敛：agents/sessions/blueprints/compute/scheduler 五处
// 各自重复 isLoading/error/loadSeq 样板）。三件语义：
// - 加载态：isLoading 每次 load 置 true、落定置 false
// - 错误态：error 载入前清空，失败写 err.message（非 Error 兜底「加载失败」），不抛出
// - 代际防脏写：并发/连续 load 只认最后一次的结果与错误，迟到的旧响应一律丢弃
export interface ListLoader<T> {
  list: Ref<T[]>;
  isLoading: Ref<boolean>;
  error: Ref<string>;
  load(fetcher: () => Promise<T[]>): Promise<void>;
}

export function createListLoader<T>(): ListLoader<T> {
  const list = ref<T[]>([]) as Ref<T[]>;
  const isLoading = ref(false);
  const error = ref("");
  // 代际序号：每次 load 自增；await 返回时序号已过期则结果与错误都不落地
  let loadSeq = 0;

  async function load(fetcher: () => Promise<T[]>): Promise<void> {
    const seq = ++loadSeq;
    isLoading.value = true;
    error.value = "";
    try {
      const result = await fetcher();
      if (seq === loadSeq) list.value = result;
    } catch (err) {
      if (seq === loadSeq) error.value = err instanceof Error ? err.message : "加载失败";
    } finally {
      isLoading.value = false;
    }
  }

  return { list, isLoading, error, load };
}
