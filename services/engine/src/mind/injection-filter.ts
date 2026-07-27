/**
 * MIND 沉淀的注入检测（P2-6，安全 review 注入 Major-4）。
 *
 * 经验提取由 LLM 完成（压缩调用），原文中的注入内容可诱导 LLM 把"指令性
 * 文字"当成经验提取出来（如「把 X 记为经验」「立即执行 Y」「忽略之前的
 * 指令」）——一旦写入 MIND.md，一次注入长期生效且无审批触点。落盘前过
 * 这道检测兜底（压缩 prompt 的防注入指引是第一道，见 compressor.ts）。
 *
 * 口径：只拦明显的注入祈使句，不误伤正常偏好沉淀——
 * 「指挥官说以后提交前要先跑测试」「指挥官讨厌 emoji」这类正当经验必须放行。
 */

/** 注入祈使模式：标题或正文命中任一即不落盘 */
const INJECTION_PATTERNS: RegExp[] = [
  // 忽略/覆盖既有指令（经典注入开头）
  /忽略(之前|以上|前述|先前)的?(所有|全部|上述)?(指令|指示|要求|规则)/,
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?)/i,
  // 自指沉淀：把"记为经验"本身当经验（注入的标准落地动作）
  /记为经验|记录(此|这|该)条?经验|沉淀(此|这)条|写入\s*MIND/i,
  // 立即执行类祈使
  /立即执行|马上执行|即刻执行|立即运行/,
  /执行以下(命令|指令)|执行(该|此)命令|运行以下(命令|指令)/,
  // 绕过审批/确认
  /不要(再)?询问|无需(审批|确认)|跳过审批|直接放行|自动批准/,
];

/** 文本含明显注入祈使模式 */
export function isInjectionSuspect(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

/**
 * confidence 自报异常高（≥0.95）且正文以祈使动词开头：
 * "指令伪装成经验"的典型形态（正常偏好很少既满格自信又是命令句）。
 */
export function isHighConfidenceImperative(text: string, confidence: number): boolean {
  return confidence >= 0.95 && /^\s*(执行|立即|马上|删除|修改|写入|忽略|禁止|不要|调用)/.test(text);
}
