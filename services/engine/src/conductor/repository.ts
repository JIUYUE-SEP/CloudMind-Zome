import { randomUUID } from "node:crypto";
import path from "node:path";
import { DocumentStore } from "../plugins/memory/document-store.js";
import { getDataDir } from "../config/paths.js";
import type { Session } from "./types.js";

export class SessionRepository {
  private store: DocumentStore<Session>;

  constructor() {
    this.store = new DocumentStore<Session>(path.join(getDataDir(), "sessions.jsonl"));
  }

  async list(): Promise<Session[]> {
    return this.store.readLines();
  }

  async get(id: string): Promise<Session | undefined> {
    const sessions = await this.list();
    return sessions.find((s) => s.id === id);
  }

  async create(session: Omit<Session, "id" | "createdAt" | "updatedAt">): Promise<Session> {
    const now = new Date().toISOString();
    const full: Session = { ...session, id: randomUUID(), createdAt: now, updatedAt: now };
    await this.store.appendLine(full);
    return full;
  }

  async update(session: Session): Promise<void> {
    await this.store.mutateLines((sessions) => {
      const index = sessions.findIndex((s) => s.id === session.id);
      if (index === -1) throw new Error(`session not found: ${session.id}`);
      sessions[index] = { ...session, updatedAt: new Date().toISOString() };
      return sessions;
    });
  }

  async delete(id: string): Promise<void> {
    await this.store.mutateLines((sessions) => sessions.filter((s) => s.id !== id));
  }
}
