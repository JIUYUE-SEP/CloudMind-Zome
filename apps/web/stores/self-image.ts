import { defineStore } from "pinia";
import { ref } from "vue";

export interface SelfImage {
  summary: string;
  style: string;
  preferences: string;
}

const STORAGE_KEY = "mc-self-image";

function isValidSelfImage(value: unknown): value is Partial<SelfImage> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SelfImage>;
  return (
    (v.summary === undefined || typeof v.summary === "string") &&
    (v.style === undefined || typeof v.style === "string") &&
    (v.preferences === undefined || typeof v.preferences === "string")
  );
}

function readStored(): Partial<SelfImage> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isValidSelfImage(parsed)) return parsed;
    }
  } catch {
    // ignore corrupted storage
  }
  return null;
}

export const useSelfImageStore = defineStore("self-image", () => {
  const selfImage = ref<SelfImage>({
    summary: "",
    style: "",
    preferences: "",
  });

  function load() {
    const stored = readStored();
    if (stored) {
      selfImage.value = { ...selfImage.value, ...stored };
    }
  }

  function save() {
    if (typeof window === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selfImage.value));
  }

  return { selfImage, load, save };
});
