import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useSelfImageStore } from "../../stores/self-image";

describe("useSelfImageStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("loads defaults when storage is empty", () => {
    const store = useSelfImageStore();
    store.load();
    expect(store.selfImage.summary).toBe("");
    expect(store.selfImage.style).toBe("");
    expect(store.selfImage.preferences).toBe("");
  });

  it("persists to localStorage", () => {
    const store = useSelfImageStore();
    store.selfImage.summary = "summary";
    store.selfImage.style = "style";
    store.save();
    expect(localStorage.getItem("mc-self-image")).toContain("summary");
    expect(localStorage.getItem("mc-self-image")).toContain("style");
  });

  it("loads persisted data", () => {
    localStorage.setItem(
      "mc-self-image",
      JSON.stringify({ summary: " persisted", style: "fast", preferences: "dark" }),
    );
    const store = useSelfImageStore();
    store.load();
    expect(store.selfImage.summary).toBe(" persisted");
    expect(store.selfImage.style).toBe("fast");
    expect(store.selfImage.preferences).toBe("dark");
  });
});
