"""Build personality description prompts from Big-5 scores."""
from __future__ import annotations


def personality_to_prompt(personality: dict | None) -> str:
    """Return group-chat stay-silent instructions.

    Big-5 scores are kept in agent config for internal probability
    calculations (e.g. stay_silent likelihood) and are NOT translated
    into natural language or injected into the system prompt.
    """
    if not personality:
        return ""

    return (
        "【重要】在群聊中，你可以选择正常回复，也可以调用 stay_silent 工具选择潜水。"
        "潜水是完全正常的行为，不是错误。不要觉得必须回复每一条消息。"
    )
