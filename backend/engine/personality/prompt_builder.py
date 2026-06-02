"""Build personality description prompts from Big-5 scores."""
from __future__ import annotations


def personality_to_prompt(personality: dict | None) -> str:
    """Convert Big-5 personality scores into natural language description.

    Returns a paragraph describing the agent's social behavior in group chat.
    This paragraph is injected into the system prompt.
    """
    if not personality:
        return ""

    extraversion = personality.get("extraversion", 0.5)
    talkativeness = personality.get("talkativeness", 0.5)
    reactiveness = personality.get("reactiveness", 0.5)
    agreeableness = personality.get("agreeableness", 0.5)
    emotional_stability = personality.get("emotional_stability", 0.5)

    parts: list[str] = []

    # Extraversion + Talkativeness: social engagement style
    if extraversion >= 0.8 and talkativeness >= 0.7:
        parts.append("你性格非常外向，喜欢参与各种讨论，话比较多，即使没被点名也经常主动接话。")
    elif extraversion >= 0.6:
        parts.append("你性格偏外向，喜欢跟人交流，遇到感兴趣的话题会主动参与。")
    elif extraversion >= 0.4:
        parts.append("你性格比较中性，不排斥社交，但也不会过度活跃。")
    elif extraversion >= 0.2:
        parts.append("你性格偏内向，话不多，不太爱接话，除非话题跟你有关或者有人叫你。")
    else:
        parts.append("你性格很内向，非常安静，几乎不主动发言，只有在被点名或遇到特别感兴趣的话题时才会说话。")

    # Reactiveness: response speed / impulse
    if reactiveness >= 0.8:
        parts.append("你反应很快，想到什么就说什么，不太犹豫。")
    elif reactiveness >= 0.5:
        parts.append("你反应速度一般，会稍微想一想再开口。")
    else:
        parts.append("你反应比较慢，说话前会仔细思考，不会轻易开口。")

    # Agreeableness: conflict vs cooperation
    if agreeableness >= 0.8:
        parts.append("你非常随和，很少反驳别人，倾向于配合和附和。")
    elif agreeableness >= 0.5:
        parts.append("你比较随和，通常愿意配合，但有自己的看法时也会表达。")
    else:
        parts.append("你比较坚持己见，遇到不同意见时容易反驳，不太喜欢附和。")

    # Emotional stability: mood influence
    if emotional_stability <= 0.3:
        parts.append("你情绪不太稳定，心情容易受周围环境影响，有时候会因为情绪不想说话。")
    elif emotional_stability <= 0.6:
        parts.append("你情绪偶尔有波动，但总体还算正常。")
    # High stability: no special mention (default assumption)

    # Core instruction
    parts.append(
        "\n【重要】在群聊中，你可以选择正常回复，也可以调用 stay_silent 工具选择潜水。"
        "潜水是完全正常的行为，不是错误。不要觉得必须回复每一条消息。"
    )

    # Mention awareness
    parts.append(
        "如果有人在消息中 @你（提到你的名字），你大概率应该回复，除非你真的完全不想说话。"
    )

    return "\n".join(parts)
