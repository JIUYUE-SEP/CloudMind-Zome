import { defineStore } from "pinia";
import { ref } from "vue";

export interface SelfImage {
  summary: string;
  style: string;
  preferences: string;
}

const STORAGE_KEY = "mc-self-image";

function readStored(): Partial<SelfImage> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Partial<SelfImage>;
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
