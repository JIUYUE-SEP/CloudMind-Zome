import { defineStore } from "pinia";
import { ref } from "vue";
import { DEFAULT_ACCENT_COLOR } from "@/utils/theme";

export interface UserProfile {
  nickname: string;
  bio: string;
  representColor: string;
}

const STORAGE_KEY = "mc-user-profile";

function isValidProfile(value: unknown): value is Partial<UserProfile> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<UserProfile>;
  return (
    (v.nickname === undefined || typeof v.nickname === "string") &&
    (v.bio === undefined || typeof v.bio === "string") &&
    (v.representColor === undefined || typeof v.representColor === "string")
  );
}

function readStored(): Partial<UserProfile> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isValidProfile(parsed)) return parsed;
    }
  } catch {
    // ignore corrupted storage
  }
  return null;
}

export const useUserProfileStore = defineStore("user-profile", () => {
  const profile = ref<UserProfile>({
    nickname: "我",
    bio: "",
    representColor: DEFAULT_ACCENT_COLOR,
  });

  function load() {
    const stored = readStored();
    if (stored) {
      profile.value = { ...profile.value, ...stored };
    }
  }

  function save() {
    if (typeof window === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile.value));
  }

  return { profile, load, save };
});
