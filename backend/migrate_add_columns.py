"""Migrate: add missing columns to existing SQLite DB."""
import sqlite3
from pathlib import Path

DB_PATH = Path.home() / ".cloudmind-zome" / "cloudmind.db"

def main():
    conn = sqlite3.connect(str(DB_PATH))
    cur = conn.cursor()

    # chat_sessions
    cur.execute("PRAGMA table_info(chat_sessions)")
    cols = {r[1] for r in cur.fetchall()}
    if "status" not in cols:
        cur.execute("ALTER TABLE chat_sessions ADD COLUMN status TEXT DEFAULT 'active'")
        print("Added chat_sessions.status")

    # chat_messages
    cur.execute("PRAGMA table_info(chat_messages)")
    cols = {r[1] for r in cur.fetchall()}
    if "client_msg_id" not in cols:
        cur.execute("ALTER TABLE chat_messages ADD COLUMN client_msg_id TEXT")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_client ON chat_messages(client_msg_id)")
        print("Added chat_messages.client_msg_id + index")

    # chat_session_members
    cur.execute("PRAGMA table_info(chat_session_members)")
    cols = {r[1] for r in cur.fetchall()}
    if "is_pinned" not in cols:
        cur.execute("ALTER TABLE chat_session_members ADD COLUMN is_pinned INTEGER DEFAULT 0")
        print("Added chat_session_members.is_pinned")
    if "last_read_at" not in cols:
        cur.execute("ALTER TABLE chat_session_members ADD COLUMN last_read_at DATETIME")
        print("Added chat_session_members.last_read_at")
    if "last_disconnect_at" not in cols:
        cur.execute("ALTER TABLE chat_session_members ADD COLUMN last_disconnect_at DATETIME")
        print("Added chat_session_members.last_disconnect_at")

    # users
    cur.execute("PRAGMA table_info(users)")
    cols = {r[1] for r in cur.fetchall()}
    if "last_seen_at" not in cols:
        cur.execute("ALTER TABLE users ADD COLUMN last_seen_at DATETIME")
        print("Added users.last_seen_at")

    # agents
    cur.execute("PRAGMA table_info(agents)")
    cols = {r[1] for r in cur.fetchall()}
    if "aliases" not in cols:
        cur.execute("ALTER TABLE agents ADD COLUMN aliases TEXT DEFAULT '[]'")
        print("Added agents.aliases")
    if "tags" not in cols:
        cur.execute("ALTER TABLE agents ADD COLUMN tags TEXT DEFAULT '[]'")
        print("Added agents.tags")

    conn.commit()
    conn.close()
    print("Migration complete.")

if __name__ == "__main__":
    main()
