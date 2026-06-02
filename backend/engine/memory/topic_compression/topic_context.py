"""Topic tree management."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class SubtopicState:
    name: str
    status: str = "active"
    done_at_count: int = 0
    done_at_ts: float = 0.0
    msg_ids: list[str] = field(default_factory=list)


@dataclass
class TopicState:
    id: str
    domain: str
    name: str
    retain: str = "normal"
    status: str = "active"
    done_at_count: int = 0
    done_at_ts: float = 0.0
    subtopics: list[SubtopicState] = field(default_factory=list)
    compressed_files: list[str] = field(default_factory=list)


class TopicContext:
    def __init__(self) -> None:
        self.topic_stack: list[TopicState] = []
        self._topic_counter: int = 0
        self._current_topic_id: Optional[str] = None
        self._same_streak: int = 0
        self._last_label: Optional[str] = None

    def push_topic(self, label: str, importance: str) -> TopicState:
        """Create new topic from label like 'Domain-Name'."""
        parts = label.split("-", 1)
        domain = parts[0]
        name = parts[1] if len(parts) > 1 else "通用"

        topic = TopicState(
            id=label,
            domain=domain,
            name=name,
            retain=importance,
        )
        self.topic_stack.append(topic)
        self._topic_counter += 1
        self._current_topic_id = topic.id
        return topic

    def push_subtopic(self, topic_id: str, sub_name: str) -> Optional[SubtopicState]:
        topic = self._find_topic(topic_id)
        if not topic:
            return None
        sub = SubtopicState(name=sub_name)
        topic.subtopics.append(sub)
        return sub

    def close_topic(self, topic_id: str) -> bool:
        topic = self._find_topic(topic_id)
        if not topic:
            return False
        topic.status = "done"
        topic.done_at_count = self._topic_counter
        topic.done_at_ts = time.time()
        if self._current_topic_id == topic_id:
            self._current_topic_id = None
        return True

    def close_subtopic(self, topic_id: str, sub_name: str) -> bool:
        topic = self._find_topic(topic_id)
        if not topic:
            return False
        for sub in topic.subtopics:
            if sub.name == sub_name and sub.status == "active":
                sub.status = "done"
                sub.done_at_count = self._topic_counter
                sub.done_at_ts = time.time()
                return True
        return False

    def get_active_subtopic(self, topic_id: str) -> Optional[SubtopicState]:
        topic = self._find_topic(topic_id)
        if not topic:
            return None
        for sub in reversed(topic.subtopics):
            if sub.status == "active":
                return sub
        # Create default subtopic if none active
        sub = SubtopicState(name=topic.name)
        topic.subtopics.append(sub)
        return sub

    def get_compressible_topics(
        self, retain_delay: dict[str, int]
    ) -> list[tuple[TopicState, SubtopicState]]:
        """Get subtopics that are done and exceed retain delay."""
        result: list[tuple[TopicState, SubtopicState]] = []
        for topic in self.topic_stack:
            if topic.status != "done":
                continue
            for sub in topic.subtopics:
                if sub.status != "done":
                    continue
                delay = retain_delay.get(topic.retain, 3)
                # Dynamic modifiers based on time since done
                elapsed = time.time() - sub.done_at_ts
                if elapsed < 3600:  # < 1h
                    delay += 2
                elif elapsed < 21600:  # < 6h
                    delay += 1
                elif elapsed > 172800:  # > 48h
                    delay = max(1, delay - 1)

                if (self._topic_counter - sub.done_at_count) >= delay:
                    result.append((topic, sub))
        return result

    def find_oldest_active_topic(self) -> Optional[TopicState]:
        for topic in self.topic_stack:
            if topic.status == "active":
                return topic
        return None

    def _find_topic(self, topic_id: Optional[str]) -> Optional[TopicState]:
        if not topic_id:
            return None
        for t in self.topic_stack:
            if t.id == topic_id:
                return t
        return None

    def to_dict(self) -> dict:
        return {
            "topic_stack": [
                {
                    "id": t.id,
                    "domain": t.domain,
                    "name": t.name,
                    "retain": t.retain,
                    "status": t.status,
                    "done_at_count": t.done_at_count,
                    "done_at_ts": t.done_at_ts,
                    "subtopics": [
                        {
                            "name": s.name,
                            "status": s.status,
                            "done_at_count": s.done_at_count,
                            "done_at_ts": s.done_at_ts,
                            "msg_ids": s.msg_ids,
                        }
                        for s in t.subtopics
                    ],
                    "compressed_files": t.compressed_files,
                }
                for t in self.topic_stack
            ],
            "topic_counter": self._topic_counter,
            "current_topic_id": self._current_topic_id,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "TopicContext":
        ctx = cls()
        ctx._topic_counter = data.get("topic_counter", 0)
        ctx._current_topic_id = data.get("current_topic_id")
        for td in data.get("topic_stack", []):
            t = TopicState(
                id=td["id"],
                domain=td["domain"],
                name=td["name"],
                retain=td.get("retain", "normal"),
                status=td.get("status", "active"),
                done_at_count=td.get("done_at_count", 0),
                done_at_ts=td.get("done_at_ts", 0.0),
                compressed_files=td.get("compressed_files", []),
            )
            for sd in td.get("subtopics", []):
                t.subtopics.append(
                    SubtopicState(
                        name=sd["name"],
                        status=sd.get("status", "active"),
                        done_at_count=sd.get("done_at_count", 0),
                        done_at_ts=sd.get("done_at_ts", 0.0),
                        msg_ids=sd.get("msg_ids", []),
                    )
                )
            ctx.topic_stack.append(t)
        return ctx
