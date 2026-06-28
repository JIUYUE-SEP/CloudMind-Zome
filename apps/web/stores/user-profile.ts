import { defineStore } from "pinia";
import { ref } from "vue";

export interface UserProfile {
  nickname: string;
  bio: string;
  representColor: string;
}

const STORAGE_KEY = "mc-user-profile";

function readStored(): Partial<UserProfile> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Partial<UserProfile>;
  } catch {
    // ignore corrupted storage
  }
  return null;
}

export const useUserProfileStore = defineStore("user-profile", () => {
  const profile = ref<UserProfile>({
    nickname: "我",
    bio: "",
    representColor: "#00e5c9",
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
