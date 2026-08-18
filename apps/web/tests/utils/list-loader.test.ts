import { describe, it, expect } from "vitest";
import { createListLoader } from "@/utils/list-loader";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createListLoader 列表加载模板（D2 共享层直测）", () => {
  it("成功：写入 list，isLoading 起落，error 保持空", async () => {
    const loader = createListLoader<number>();
    const d = deferred<number[]>();
    const pending = loader.load(() => d.promise);
    expect(loader.isLoading.value).toBe(true);

    d.resolve([1, 2]);
    await pending;
    expect(loader.list.value).toEqual([1, 2]);
    expect(loader.isLoading.value).toBe(false);
    expect(loader.error.value).toBe("");
  });

  it("失败：error 写 err.message，list 保持旧值；非 Error 兜底「加载失败」", async () => {
    const loader = createListLoader<number>();
    await loader.load(() => Promise.resolve([1]));

    await loader.load(() => Promise.reject(new Error("boom")));
    expect(loader.error.value).toBe("boom");
    expect(loader.list.value).toEqual([1]);
    expect(loader.isLoading.value).toBe(false);

    await loader.load(() => Promise.reject("nope"));
    expect(loader.error.value).toBe("加载失败");
  });

  it("再次加载先清上轮 error（在途期间即清空）", async () => {
    const loader = createListLoader<number>();
    await loader.load(() => Promise.reject(new Error("boom")));
    expect(loader.error.value).toBe("boom");

    const d = deferred<number[]>();
    const pending = loader.load(() => d.promise);
    expect(loader.error.value).toBe("");
    d.resolve([2]);
    await pending;
    expect(loader.list.value).toEqual([2]);
  });

  it("代际防脏写：旧加载迟到返回，结果不覆盖新代际", async () => {
    const loader = createListLoader<string>();
    const slow = deferred<string[]>();
    const stale = loader.load(() => slow.promise);
    await loader.load(() => Promise.resolve(["new"]));
    expect(loader.list.value).toEqual(["new"]);

    slow.resolve(["stale"]);
    await stale;
    expect(loader.list.value).toEqual(["new"]);
    expect(loader.error.value).toBe("");
  });

  it("代际防脏写：旧加载迟到失败，error 不落地", async () => {
    const loader = createListLoader<string>();
    const slow = deferred<string[]>();
    const stale = loader.load(() => slow.promise);
    await loader.load(() => Promise.resolve(["new"]));

    slow.reject(new Error("stale error"));
    await stale;
    expect(loader.list.value).toEqual(["new"]);
    expect(loader.error.value).toBe("");
  });
});
