/**
 * 落盘格式版本与迁移机制（P1-1，数据 review M4）。
 *
 * 版本字段策略：
 * - 单文件 JSON（config.json、agent.json）：顶层 `schemaVersion`。
 * - JSONL（sessions/blueprints/messages/messages_archived/scheduler/mind-failed 等）：
 *   每行记录带 `schemaVersion`，而不是文件首行一条 meta 记录。取舍：append-only
 *   文件的格式升级发生在文件生命中期，首行 meta 意味着"整文件一个版本"——升级时
 *   要么全量重写文件（messages_archived 是百 MB 级只增文件，不可接受），要么容忍
 *   新旧格式行混排而 meta 撒谎。每行版本让 append 路径零感知（新行盖当前版本戳），
 *   旧行保持旧版本，读取时按行版本各自迁移，天然兼容混合版本文件；代价是每行
 *   十余字节冗余，相对 embedding 行 10-20KB 可忽略。
 * - frontmatter 文件（_compressed/{topicId}.md、MIND.md 经验块）：frontmatter 加
 *   `schema: N`（frontmatter key 风格为小写/snake_case）。
 * - sidecar 的 embeddings.jsonl 同 JSONL 方案（Rust 侧 serde rename 同名字段）。
 *
 * 读取兼容：无版本字段的旧文件一律视为 v1（现存数据全是 v1，必须照常读出）；
 * 版本高于当前代码认识的版本时抛 UnsupportedSchemaVersionError——显式报错，
 * 绝不静默读空。
 *
 * 迁移时机：读时惰性迁移（读到旧版就迁）。不选启动批量迁移：以月/年计的数据量
 * 下每次启动全量扫描+重写太慢，且批量写回本身是风险动作；惰性迁移只在真正读到
 * 该数据时按记录/按文件迁移，热文件经 mutateLines 写回时自然物理升级为当前版本，
 * 冷数据（归档）每次读取时在内存中迁移即可。
 */

export const CURRENT_SCHEMA_VERSION = 1;

/**
 * 数据由更新版本的程序写入、当前代码不认识其格式：显式报错。
 * 各读取路径不得把它按"坏行/坏档"吞掉（不静默读空），文件本身不做任何改动。
 */
export class UnsupportedSchemaVersionError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly foundVersion: number,
    public readonly supportedVersion: number,
  ) {
    super(
      `落盘格式版本过高：${filePath} 是 v${foundVersion}，当前代码最高支持 v${supportedVersion}；` +
        `请升级程序后再读取（文件未做任何改动）`,
    );
    this.name = "UnsupportedSchemaVersionError";
  }
}

/** vN → vN+1 的单级迁移函数 */
export type MigrationFn<T> = (data: T) => T;

/**
 * 单一格式的迁移函数注册表：register(N, fn) 注册 vN → vN+1 一级；
 * 读到旧版本数据时从 N 开始逐级应用至当前版本。
 * 当前全部格式为 v1，注册表为空——机制就位，第一次格式变更时填第一级。
 */
export class MigrationChain<T> {
  private readonly steps = new Map<number, MigrationFn<T>>();

  constructor(public readonly currentVersion: number) {}

  register(fromVersion: number, fn: MigrationFn<T>): this {
    if (!Number.isInteger(fromVersion) || fromVersion < 1 || fromVersion >= this.currentVersion) {
      throw new Error(`invalid migration step: v${fromVersion} (current v${this.currentVersion})`);
    }
    this.steps.set(fromVersion, fn);
    return this;
  }

  /**
   * 把 fromVersion 的数据逐级迁到 currentVersion。
   * 高于当前版本抛 UnsupportedSchemaVersionError；链缺环节抛错（注册表残缺，显式失败）。
   */
  migrate(data: T, fromVersion: number, context: string): T {
    if (fromVersion > this.currentVersion) {
      throw new UnsupportedSchemaVersionError(context, fromVersion, this.currentVersion);
    }
    let result = data;
    for (let v = fromVersion; v < this.currentVersion; v++) {
      const step = this.steps.get(v);
      if (!step) {
        throw new Error(`迁移链缺环节：${context} 注册表缺 v${v} → v${v + 1} 的迁移函数`);
      }
      result = step(result);
    }
    return result;
  }
}

/**
 * 从解析出的对象上分离版本字段：无 `schemaVersion`（旧数据）视为 v1；
 * 非整数/非法值按损坏处理同样回落 v1（由读取侧既有的坏数据降级逻辑兜底）。
 * 返回的 data 不含版本字段——业务类型上没有它，避免污染 toEqual 断言与二次写回。
 */
export function splitSchemaVersion<T extends object>(obj: T): { version: number; data: T } {
  if (obj === null || typeof obj !== "object") return { version: 1, data: obj };
  const raw = obj as Record<string, unknown>;
  if (!("schemaVersion" in raw)) return { version: 1, data: obj };
  const sv = raw.schemaVersion;
  const version = typeof sv === "number" && Number.isInteger(sv) && sv >= 1 ? sv : 1;
  const data = { ...raw };
  delete data.schemaVersion;
  return { version, data: data as T };
}

/** 写盘前盖版本戳：单文件 JSON 顶层 / JSONL 每行统一 `schemaVersion` */
export function stampSchemaVersion<T extends object>(
  data: T,
  version: number,
): T & { schemaVersion: number } {
  return { ...data, schemaVersion: version };
}

/** frontmatter 格式的版本（`schema: N`）：无该 key（旧数据）或值非法时视为 v1 */
export function frontmatterVersion(fm: Record<string, string>): number {
  const raw = fm["schema"];
  if (raw === undefined) return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}
