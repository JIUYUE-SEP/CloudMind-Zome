use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use hnsw_rs::prelude::*;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;

use crate::data_dir;
use crate::sanitize_agent_id;

/// HNSW 参数：ef_construction 取 100 而非教科书 200——插入成本与之近似线性，
/// 万条冷载入与运行期 upsert 都直接减半，召回率在该规模下无感差异
const HNSW_MAX_NB_CONNECTION: usize = 16;
const HNSW_MAX_LAYER: usize = 16;
const HNSW_EF_CONSTRUCTION: usize = 100;

/// compaction 触发下限：行数（启动时）/ 孤儿点数（运行期，M47）超过唯一
/// 文档数 2 倍且超过该下限才重写，避免小文件/小索引无意义 IO
const COMPACTION_MIN_LINES: usize = 100;

/// 小索引直接精确线性扫描的上限：此规模下线性成本可忽略，
/// 且规避近似图在大量并列距离时的召回波动（如 50 个距离全相同的点）
const LINEAR_SCAN_MAX: usize = 256;

// ---- 内存观测（P1-5，review M9）----
// 全量驻留不设上限、不做逐出：单用户本地场景量化评估与根治触发条件见
// docs/架构文档.md §9.1。此处只负责观测——驻留估算随规模记录，超阈值升 warn。

/// 每 doc 驻留内存估算的固定开销（doc_id 映射、Vec/String 头、HNSW 层间链接）
const PER_DOC_OVERHEAD_BYTES: usize = 1024;
/// 向量驻留份数：docs HashMap（持久化/重载事实源）与 HNSW 图
/// （hnsw_rs 的 Point 按值持有数据）各持一份
const VECTOR_RESIDENT_COPIES: usize = 2;
/// 运行期驻留估算的记录档位：docs 每跨一档记录一次
const MEM_LOG_STRIDE_DOCS: usize = 10_000;
/// 驻留告警阈值：1536 维 ≈ 650MB 驻留；超过应评估数据治理（§9.1 触发条件）
const MEM_WARN_DOCS: usize = 50_000;

fn estimate_resident_bytes(doc_count: usize, dim: usize) -> usize {
    doc_count * (dim * std::mem::size_of::<f32>() * VECTOR_RESIDENT_COPIES + PER_DOC_OVERHEAD_BYTES)
}

/// 从 before 增至 after 是否跨过 MEM_LOG_STRIDE_DOCS 档位（重复 upsert 同
/// doc_id 不增长 docs，自然不触发）
fn crossed_mem_stride(before: usize, after: usize) -> bool {
    after > before && after / MEM_LOG_STRIDE_DOCS != before / MEM_LOG_STRIDE_DOCS
}

fn mem_log_is_warn(doc_count: usize) -> bool {
    doc_count >= MEM_WARN_DOCS
}

/// embeddings.jsonl 记录格式当前版本（P1-1，与 engine 侧 JSONL 同一方案：
/// 每行记录带 schemaVersion 字段；无字段的旧行视为 v1，高于当前版本显式报错）。
/// v2（M14）：新增 deleted 墓碑行——旧版 sidecar 读到 v2 行会显式报
/// "too new" 而非把墓碑行当空向量载入，正是 P1-1 版本机制的 fail-loud 设计意图
const EMBEDDINGS_SCHEMA_VERSION: u32 = 2;

type HnswIndex = Hnsw<'static, f32, DistCosine>;

pub struct VectorIndexState {
    dir: PathBuf,
    /// 索引维度：首个向量的维度即全索引维度（0 = 空索引未定维）。
    /// 空索引（新建，或冷载入无有效行/异维行被众数维度跳过）dim 保持 0，
    /// 由首个非空 upsert 钉住维度，此后异维写入/查询一律在 gRPC 入口
    /// 以 invalid_argument 显式拒绝（H10b）。
    /// anndists DistCosine::eval 对异维向量直接 assert panic，且污染文件会让
    /// 每次冷载入复发——异维 upsert/search 必须在入口拒绝（P0 review 返工）
    dim: usize,
    /// doc_id -> 最新向量（持久化与重载的唯一事实源）
    docs: HashMap<String, Vec<f32>>,
    index: HnswIndex,
    /// 内部点 id -> doc_id
    ids: Vec<String>,
    /// doc_id -> 最新内部点 id。hnsw_rs 不支持删除点：同 doc_id 重复 upsert
    /// 会插入新点、旧点成孤儿，search 只认该表登记的最新点
    doc_ids: HashMap<String, usize>,
    /// 退役标记（M47 代际方案的内存半）：delete_agent 持本状态写锁置位后
    /// 才删目录。此后经旧句柄（删除窗口前已拿到 Arc 的在飞调用方）的迟到
    /// upsert/delete_docs 在入口被拒——不重建已删的 embeddings.jsonl，
    /// 被删 agent 的向量不会随迟到写入复活落盘
    retired: bool,
}

impl VectorIndexState {
    /// 索引当前维度（0 = 空索引未定维）：gRPC 入口据此做维度校验（H10b）
    pub fn dim(&self) -> usize {
        self.dim
    }

    pub async fn upsert(&mut self, doc_id: &str, embedding: &[f32]) {
        // 退役索引（M47）：agent 已删除，经旧句柄的迟到 upsert 一律拒绝——
        // 放行会经 persist_append 重建已删的 embeddings.jsonl，旧记忆复活
        if self.retired {
            tracing::warn!(
                "upsert for {} rejected: index retired (agent deleted)",
                doc_id
            );
            return;
        }
        // 空向量不入索引（H10b 防御层）：0 维写入会让 dim 永远钉不住、
        // 并在距离求值处 panic。gRPC 入口已先行 invalid_argument 拒绝，
        // 此处兜底直接调用方
        if embedding.is_empty() {
            tracing::warn!("empty embedding for {} rejected", doc_id);
            return;
        }
        // 维度门禁（P0 review 返工）：异维向量入索引会在距离求值处 panic，
        // 拒绝并告警，不落盘、不入索引
        if self.dim == 0 {
            self.dim = embedding.len();
        } else if embedding.len() != self.dim {
            tracing::warn!(
                "embedding dim mismatch for {}: got {}, index dim is {}; rejected",
                doc_id,
                embedding.len(),
                self.dim
            );
            return;
        }
        let before = self.docs.len();
        self.docs.insert(doc_id.to_string(), embedding.to_vec());
        // 增量插入单点（P0-5）：成本 O(log n) 级，不再 dirty 后 search 前全量重建
        let internal_id = self.ids.len();
        self.index.insert((embedding, internal_id));
        self.ids.push(doc_id.to_string());
        self.doc_ids.insert(doc_id.to_string(), internal_id);
        // 内存观测（P1-5）：每跨 1 万条档位记录驻留估算，超 5 万条升 warn
        if crossed_mem_stride(before, self.docs.len()) {
            self.log_mem_stats(None);
        }
        self.persist_append(doc_id, embedding).await;
        // M47：重复 upsert 的孤儿点在会话内无界累积（原仅启动时 compaction），
        // 运行期达阈值即重建索引 + 重写文件物理剔除
        self.maybe_compact_runtime().await;
    }

    /// 批量删除（M14 tombstone 方案）：docs/doc_ids 同步移除——search 两条
    /// 路径只认这两个表，被删文档立即不可见；HNSW 中的点成为孤儿点，由
    /// 运行期/启动 compaction 物理剔除。每个实删 doc_id 追加一条 deleted
    /// 墓碑行落盘，重启加载时按行序应用（后行覆盖前行语义不变：墓碑后的
    /// 新 upsert 行可让同 doc_id 复活）。幂等：不在索引中的 doc_id 跳过，
    /// 不重复落墓碑行。返回实删条数。
    pub async fn delete_docs(&mut self, doc_ids: &[String]) -> usize {
        // 与 upsert 同一退役防线（M47）：迟到删除无需也不应再落盘
        if self.retired {
            tracing::warn!(
                "delete_docs ({} ids) rejected: index retired (agent deleted)",
                doc_ids.len()
            );
            return 0;
        }
        let mut deleted = 0usize;
        for doc_id in doc_ids {
            if self.docs.remove(doc_id).is_none() {
                continue;
            }
            self.doc_ids.remove(doc_id);
            deleted += 1;
            self.persist_tombstone(doc_id).await;
        }
        if deleted > 0 {
            // 删除同样制造孤儿点：与 upsert 同一条运行期 compaction 触发线
            self.maybe_compact_runtime().await;
        }
        deleted
    }

    /// 运行期 compaction（M47）：孤儿点（重复 upsert 的旧点 + 已删文档的点）
    /// 达下限且总点数 ids 超过存活 docs 两倍才重建，避免小索引无意义 IO。
    /// 与启动 compaction 同思不同口径：启动按文件行数（含墓碑行/异维行，
    /// 分子是盘上 jsonl 行数）判定；运行期按内存孤儿点数（ids - docs）判定。
    /// hnsw_rs 不支持删点，物理剔除 = 按 docs 全量重建内存索引 +
    /// 重写 embeddings.jsonl（复用启动 compaction 的 tmp+rename 原子写）。
    /// 调用方持本状态写锁（upsert/delete_docs 的 &mut self），与在飞
    /// persist_append 不并发，重写丢行窗口不存在
    async fn maybe_compact_runtime(&mut self) {
        let orphans = self.ids.len() - self.docs.len();
        if orphans < COMPACTION_MIN_LINES || self.ids.len() <= self.docs.len().saturating_mul(2) {
            return;
        }
        let (index, ids, doc_ids) = build_index(&self.docs);
        self.index = index;
        self.ids = ids;
        self.doc_ids = doc_ids;
        compact_embeddings(&self.dir, &self.docs).await;
        tracing::info!(
            dir = %self.dir.display(),
            docs = self.docs.len(),
            orphans_removed = orphans,
            "runtime compaction: rebuilt index and rewrote embeddings.jsonl"
        );
    }

    /// 内存观测（P1-5，M9）：驻留估算随规模落日志。估算口径：向量 2 份
    /// （docs + HNSW Point）+ 每 doc 固定开销；file_bytes 仅冷载入时可知。
    fn log_mem_stats(&self, file_bytes: Option<u64>) {
        let doc_count = self.docs.len();
        let est_mb = estimate_resident_bytes(doc_count, self.dim) / (1 << 20);
        let file_mb = file_bytes.map(|b| b / (1 << 20));
        if mem_log_is_warn(doc_count) {
            tracing::warn!(
                dir = %self.dir.display(), docs = doc_count, dim = self.dim,
                est_resident_mb = est_mb, file_mb = ?file_mb,
                "vector index resident estimate above warn threshold (see docs/架构文档.md §9.1 triggers)"
            );
        } else {
            tracing::info!(
                dir = %self.dir.display(), docs = doc_count, dim = self.dim,
                est_resident_mb = est_mb, file_mb = ?file_mb,
                "vector index resident estimate"
            );
        }
    }

    /// 只读检索：索引在 upsert 时已增量更新，search 不再做任何重建，
    /// server 侧可持读锁并发执行（原全量重建持写锁阻塞整个 runtime）
    pub fn search(&self, query: &[f32], top_k: usize) -> Vec<(String, f32)> {
        if top_k == 0 || self.ids.is_empty() {
            return Vec::new();
        }
        // 异维查询（P0 review 返工）：HNSW 路径会在 DistCosine::eval 处 panic，
        // 直接返回空——维度不同本无相似性可言
        if self.dim != 0 && query.len() != self.dim {
            tracing::warn!(
                "search query dim {} != index dim {}; returning empty",
                query.len(),
                self.dim
            );
            return Vec::new();
        }
        if self.ids.len() <= LINEAR_SCAN_MAX {
            return self.linear_search(query, top_k);
        }
        // 候选池放大：过滤孤儿点（重复 upsert 的旧向量）后仍需凑够 top_k
        let knbn = (top_k * 4).max(64).min(self.ids.len());
        let ef = knbn.max(64);
        let mut seen = HashSet::with_capacity(top_k);
        let mut results = Vec::with_capacity(top_k);
        for neighbour in self.index.search(query, knbn, ef) {
            let doc_id = &self.ids[neighbour.d_id];
            // 只认最新点：同 doc_id 的旧向量是过期数据
            if self.doc_ids.get(doc_id) != Some(&neighbour.d_id) {
                continue;
            }
            if !seen.insert(doc_id.clone()) {
                continue;
            }
            results.push((doc_id.clone(), neighbour.distance));
            if results.len() == top_k {
                break;
            }
        }
        results
    }

    /// docs 只存每个 doc_id 的最新向量，线性扫描天然无重复 upsert 的孤儿问题
    fn linear_search(&self, query: &[f32], top_k: usize) -> Vec<(String, f32)> {
        let mut scored: Vec<(String, f32)> = self
            .docs
            .iter()
            .filter_map(|(doc_id, embedding)| {
                if embedding.len() != query.len() {
                    return None;
                }
                Some((doc_id.clone(), 1.0 - cosine_similarity(query, embedding)))
            })
            .collect();
        scored.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.into_iter().take(top_k).collect()
    }

    /// 追加单行持久化（原每次 upsert 全量重写 + fsync，一轮对话 N 条消息即 N 次全量落盘）。
    /// 文件为 append-only：同 doc_id 后行覆盖前行（加载时按行序应用）。
    /// 不逐条 fsync——嵌入索引是从消息派生的冗余数据，OS 级崩溃丢失少量尾部可接受；
    /// 失败仅告警，不影响主链路。
    async fn persist_append(&self, doc_id: &str, embedding: &[f32]) {
        self.persist_record(&Record {
            doc_id: doc_id.to_string(),
            embedding: embedding.to_vec(),
            schema_version: Some(EMBEDDINGS_SCHEMA_VERSION),
            deleted: false,
        })
        .await;
    }

    /// 追加墓碑行（M14）：与 persist_append 同文件同语义（append-only、
    /// 不逐条 fsync、失败仅告警）；行带 deleted:true 与 v2 版本戳
    async fn persist_tombstone(&self, doc_id: &str) {
        self.persist_record(&Record {
            doc_id: doc_id.to_string(),
            embedding: Vec::new(),
            schema_version: Some(EMBEDDINGS_SCHEMA_VERSION),
            deleted: true,
        })
        .await;
    }

    async fn persist_record(&self, record: &Record) {
        let path = self.dir.join("embeddings.jsonl");
        let line = match serde_json::to_string(record) {
            Ok(l) => l + "\n",
            Err(e) => {
                tracing::warn!("embedding serialize failed for {}: {}", record.doc_id, e);
                return;
            }
        };
        if let Err(e) = fs::create_dir_all(&self.dir).await {
            tracing::warn!("embedding dir create failed: {}", e);
            return;
        }
        let mut file = match fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
        {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!("embedding file open failed: {}", e);
                return;
            }
        };
        if let Err(e) = file.write_all(line.as_bytes()).await {
            tracing::warn!("embedding append failed for {}: {}", record.doc_id, e);
            return;
        }
        // tokio fs::File 的 write_all 只把数据拷进内部缓冲即返回（真实 write 在
        // blocking 任务里异步完成）；不 flush 就返回，紧随其后的读（同进程立即
        // 读回，如测试/校验路径）可能看不到新行——低核数机器上必现。flush 等待
        // 在飞写任务完成（write 系统调用落地，非 fsync），并顺带暴露其错误
        if let Err(e) = file.flush().await {
            tracing::warn!("embedding append flush failed for {}: {}", record.doc_id, e);
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Record {
    doc_id: String,
    /// 墓碑行（deleted:true）为空 vec——加载时先看 deleted，不看 embedding
    embedding: Vec<f32>,
    /// 格式版本（P1-1）：旧行无此字段（反序列化为 None，视为 v1）；
    /// 写入时盖当前版本戳；高于当前版本加载时显式报错，不静默跳过
    #[serde(rename = "schemaVersion", default)]
    schema_version: Option<u32>,
    /// 删除墓碑（M14，v2 起）：true = 该 doc_id 已删除。append-only 落盘，
    /// 加载按行序应用（墓碑从 docs 移除，其后的 upsert 行可复活同 doc_id）；
    /// compaction 重写时物理剔除，不再写出。正常行不序列化该字段（零体积代价）
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    deleted: bool,
}

/// 记录级版本迁移（P1-1，与 engine 侧 MigrationChain 同一设计）：把 from_version
/// 的记录逐级迁到当前版本。v1→v2 仅新增 deleted 墓碑字段（反序列化 default
/// false），记录本体无需变换；未来 v2→v3 迁移作为下一级加在这里，逐级链式应用。
fn migrate_record(record: Record, from_version: u32) -> Record {
    debug_assert!((1..=EMBEDDINGS_SCHEMA_VERSION).contains(&from_version));
    let _ = from_version;
    record
}

static INDEX_CACHE: std::sync::LazyLock<RwLock<HashMap<String, Arc<RwLock<VectorIndexState>>>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

/// 删除代际注册表（M47 代际方案的持久半是目录删除本身，这里是内存半）：
/// delete_agent 每执行一次，该 agent 代际 +1。get_or_load 冷载入前取快照、
/// 构建完成入缓存前在缓存写锁内复比——不一致说明载入期间发生过删除，
/// 构建结果（删除前读到的旧向量）必须丢弃重来，被删 agent 的向量不会在
/// 内存复活。进程内单调递增即够用：磁盘目录已删，重启后天然从空索引开始
///
/// 锁序（C2 既定，R1 后不变）：INDEX_CACHE → DELETE_GENERATIONS——
/// get_or_load 复比处持缓存写锁读代际；delete_agent 持缓存写锁写代际。
/// 不存在持 DELETE_GENERATIONS 反取 INDEX_CACHE 的路径，无环
static DELETE_GENERATIONS: std::sync::LazyLock<RwLock<HashMap<String, u64>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

async fn delete_generation(agent_id: &str) -> u64 {
    *DELETE_GENERATIONS.read().await.get(agent_id).unwrap_or(&0)
}

pub async fn get_or_load(agent_id: &str) -> anyhow::Result<Arc<RwLock<VectorIndexState>>> {
    let agent_id = sanitize_agent_id(agent_id)?;

    // M47 代际防线：载入期间发生 delete_agent 时构建结果必须丢弃重来——
    // 每轮循环重读缓存，并发同名重建/删除风暴下也能收敛（删除次数有限）
    loop {
        {
            let cache = INDEX_CACHE.read().await;
            if let Some(state) = cache.get(&agent_id) {
                return Ok(Arc::clone(state));
            }
        }

        // 重活（读盘 + JSON 解析 + 并行建索引）在缓存写锁外完成：
        // 避免一个 agent 的冷载入（万条级秒级）阻塞其他 agent 的首次加载
        let gen_snapshot = delete_generation(&agent_id).await;
        let built = load_state(&agent_id).await?;

        let mut cache = INDEX_CACHE.write().await;
        // 并发竞争加载：先到者生效，重复构建直接丢弃
        if let Some(state) = cache.get(&agent_id) {
            return Ok(Arc::clone(state));
        }
        // 代际比对（M47）：快照后发生过 delete_agent，built 含删除前的旧
        // 向量——丢弃并重来（下一轮磁盘已删，载入为空索引）。锁序固定为
        // INDEX_CACHE → DELETE_GENERATIONS，delete_agent 同向嵌套持锁
        // （缓存写锁内写代际），无反向路径，无死锁
        if delete_generation(&agent_id).await != gen_snapshot {
            tracing::warn!(
                "agent {} deleted during cold load; discarding stale index build",
                agent_id
            );
            drop(cache);
            continue;
        }
        cache.insert(agent_id, Arc::clone(&built));
        return Ok(built);
    }
}

/// 删除 agent 的全部向量数据（P1-3，review M3）：逐出 INDEX_CACHE + 删除磁盘
/// indices 目录。此前缓存进程常驻无失效入口：删除 agent 后同名重建会命中旧向量
/// 全集，旧记忆复活并随新 upsert 重新落盘。
/// 幂等：agent 不存在（缓存/磁盘都没有）同样返回 Ok。
///
/// M47 竞态根治（代际/退役标记，复用 M14 tombstone 基建的触发链）：
/// 1. reload 通道：代际 +1，get_or_load 载入期间发生删除则丢弃构建结果重来
///    （见 get_or_load），旧向量不再入缓存；
/// 2. 在飞 upsert 通道：持状态写锁置 retired 后再删目录——锁释放后经旧句柄
///    的迟到 upsert/delete_docs 在入口被拒，不重建已删的 embeddings.jsonl。
///
/// R1 窄窗口根治：上述四步收进同一临界区（INDEX_CACHE.write 全程持有，
/// DELETE_GENERATIONS.write 嵌套其中同样横跨删目录 IO）。R1 前四步不持同一
/// 锁，冷载入的代际快照可落在"代际+1 之后、删目录完成之前"——快照与复比看到
/// 相同代际（复比通过），载入却读到删除前的旧文件，旧向量以未置 retired 的
/// 新状态重入缓存。get_or_load 相对本函数只有两个同步点：载入前经
/// DELETE_GENERATIONS.read 取快照、载入后持 INDEX_CACHE.write 复比——两把
/// 写锁横跨整个临界区后，快照要么在临界区之前（复比必然读到 +1 后的代际，
/// 不一致，丢弃重来），要么被挡到临界区之后（目录已删，载入读到空目录），
/// 窗口在时序上不复存在。
///
/// 代价评估：删目录 IO（单 agent 一个 jsonl 量级，毫秒）期间两把写锁持有，
/// 阻塞其他 agent 的冷载入快照与缓存读。删除 agent 是单用户低频操作
/// （engine 删除路由发 DeleteAgent RPC 前已停掉该 agent 流量），阻塞量级
/// 可接受——换来复活窗口的确定性消除。
///
/// engine 删除路由在发 DeleteAgent RPC 前已停掉该 agent 流量（worker 随
/// onChange 移除），两道防线覆盖的是"已拿到旧句柄但尚未进锁"的残余窗口。
pub async fn delete_agent(agent_id: &str) -> anyhow::Result<()> {
    let agent_id = sanitize_agent_id(agent_id)?;

    // 单临界区（R1）：锁序 INDEX_CACHE → DELETE_GENERATIONS → 状态写锁，
    // 与 get_or_load 复比处同向，无环
    let mut cache = INDEX_CACHE.write().await;
    let mut gens = DELETE_GENERATIONS.write().await;
    // 代际 +1：挡住在飞冷载入把删除前旧向量重新入缓存（reload 通道）
    *gens.entry(agent_id.clone()).or_insert(0) += 1;

    if let Some(state) = cache.remove(&agent_id) {
        // 持状态写锁置退役标记：等在飞 upsert/search 全部完成；锁释放后经
        // 旧句柄的迟到 upsert 被 retired 挡在入口（upsert 首行检查），
        // 不会在目录删除后经 persist_append 重建文件
        state.write().await.retired = true;
    }

    // 测试钩子（R1 复活窗口测试）：此刻代际已 +1、缓存已逐出、目录未删，
    // 正是 R1 前复活窗口的张开位置——暂停于此让测试在窗口内发起冷载入
    #[cfg(test)]
    {
        let hook = DELETE_WINDOW_HOOK.lock().await.take();
        if let Some((entered, resume)) = hook {
            let _ = entered.send(());
            let _ = resume.await;
        }
    }

    let result = remove_index_dir(&agent_id).await;
    drop(gens);
    drop(cache);
    result
}

/// 窗口屏障两端（R1 测试）：entered 通知测试"窗口已张开"（两把写锁持有中、
/// 目录未删），resume 等测试放行删目录
#[cfg(test)]
type DeleteWindowBarrier = (
    tokio::sync::oneshot::Sender<()>,
    tokio::sync::oneshot::Receiver<()>,
);

/// 测试钩子（M47 R1 复活窗口测试专用）：delete_agent 在代际+1/逐出/置
/// retired 之后、删目录之前暂停于屏障。仅 cfg(test) 编译，生产零开销
#[cfg(test)]
static DELETE_WINDOW_HOOK: std::sync::LazyLock<tokio::sync::Mutex<Option<DeleteWindowBarrier>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(None));

/// 删除 agents/{id}/indices 目录；不存在视为成功（幂等）
async fn remove_index_dir(agent_id: &str) -> anyhow::Result<()> {
    let dir = data_dir().join("agents").join(agent_id).join("indices");
    match fs::remove_dir_all(&dir).await {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

async fn load_state(agent_id: &str) -> anyhow::Result<Arc<RwLock<VectorIndexState>>> {
    let dir = data_dir()
        .join("agents")
        .join(agent_id)
        .join("indices")
        .join("hnsw");
    fs::create_dir_all(&dir).await.ok();

    let path = dir.join("embeddings.jsonl");
    let mut docs = HashMap::new();
    // M48：区分冷启与真错误——ENOENT 是正常冷启动（空索引）；其余读错误
    // （权限/IO/非法 UTF-8 等）原实现 unwrap_or_default 静默当空索引，记忆
    // 表现为"消失"而无任何线索。降级语义不变（空索引不阻断启动），但 warn 留痕
    let content = match fs::read_to_string(&path).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            tracing::warn!(
                "embeddings.jsonl read failed for agent {} ({}); starting with empty index",
                agent_id,
                e
            );
            String::new()
        }
    };
    let line_count = content.lines().count();
    if !content.is_empty() {
        // 并行解析：按行边界切块多线程 JSON 解析（万条级 44MB 解析是冷载入主要成本）
        for record in parse_records_parallel(&content) {
            // 版本字段（P1-1）：无 schemaVersion 的旧行视为 v1；高于当前版本显式
            // 报错（engine 侧收到错误后 L4 降级并明确告知，不静默读空）；旧版按需迁移
            let version = record.schema_version.filter(|v| *v >= 1).unwrap_or(1);
            if version > EMBEDDINGS_SCHEMA_VERSION {
                return Err(anyhow::anyhow!(
                    "embeddings.jsonl schema version too new for agent {agent_id}: v{version}, this sidecar supports up to v{EMBEDDINGS_SCHEMA_VERSION}; upgrade the sidecar (file left unchanged)"
                ));
            }
            let record = migrate_record(record, version);
            // 墓碑行（M14 v2）：从 docs 移除；其后的 upsert 行重新插入——
            // 与"后行覆盖前行"同一行序语义
            if record.deleted {
                docs.remove(&record.doc_id);
                continue;
            }
            docs.insert(record.doc_id, record.embedding);
        }
    }

    // 维度一致性（P0 review 返工）：混入异维数据（如更换 embedding provider）
    // 会在 HNSW 距离求值/并行插入处 panic 且每次冷载入复发。以众数维度为准
    // 跳过异维行，compaction 顺带把异维行从盘上清掉
    let dim = majority_dim(&docs);
    if dim != 0 {
        let before = docs.len();
        docs.retain(|_, embedding| embedding.len() == dim);
        let skipped = before - docs.len();
        if skipped > 0 {
            tracing::warn!(
                "skipped {} embeddings with dim != {} during load (agent {})",
                skipped,
                dim,
                agent_id
            );
        }
    }

    // append-only 文件只加不压（M9）：行数远超唯一文档数时启动重写去重，
    // 写 tmp + rename 原子替换，崩溃不留半截文件。墓碑行（M14）同样计入
    // line_count 而被删文档不在 docs——删除累积自然推高比值触发重写，
    // 墓碑与被删文档随重写物理剔除（重写只出存活文档）
    if line_count > docs.len().saturating_mul(2).max(COMPACTION_MIN_LINES) {
        compact_embeddings(&dir, &docs).await;
    }

    let (index, ids, doc_ids) = build_index(&docs);
    let state = VectorIndexState {
        dir,
        dim,
        docs,
        index,
        ids,
        doc_ids,
        retired: false,
    };
    // 冷载入内存观测（P1-5）：每次启动记录一次全量驻留估算（含文件体积）
    state.log_mem_stats(Some(content.len() as u64));
    Ok(Arc::new(RwLock::new(state)))
}

/// 从 docs 全量构建内存索引（启动载入与 M47 运行期 compaction 共用）：
/// 先固定内部 id 顺序，再并行插入（hnsw_rs 的 insert 为 &self 且 Sync，
/// 官方支持并发插入）。万条规模串行插入秒级，并行后压到亚秒，
/// 避免 sidecar 重启后首次 search 撞 TS 客户端 3000ms deadline
fn build_index(
    docs: &HashMap<String, Vec<f32>>,
) -> (HnswIndex, Vec<String>, HashMap<String, usize>) {
    let index = HnswIndex::new(
        HNSW_MAX_NB_CONNECTION,
        docs.len().max(16),
        HNSW_MAX_LAYER,
        HNSW_EF_CONSTRUCTION,
        DistCosine,
    );
    let mut ids = Vec::with_capacity(docs.len());
    let mut doc_ids = HashMap::with_capacity(docs.len());
    let mut items: Vec<(&Vec<f32>, usize)> = Vec::with_capacity(docs.len());
    for (doc_id, embedding) in docs {
        let internal_id = ids.len();
        ids.push(doc_id.clone());
        doc_ids.insert(doc_id.clone(), internal_id);
        items.push((embedding, internal_id));
    }
    parallel_insert(&index, &items);
    (index, ids, doc_ids)
}

/// 众数维度：混入异维数据时以多数派为准（更换 provider 后新数据随时间成为多数）。
/// 空索引返回 0（未定维，由首个 upsert 定维）
fn majority_dim(docs: &HashMap<String, Vec<f32>>) -> usize {
    let mut counts: HashMap<usize, usize> = HashMap::new();
    for embedding in docs.values() {
        *counts.entry(embedding.len()).or_insert(0) += 1;
    }
    counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(dim, _)| dim)
        .unwrap_or(0)
}

fn worker_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8)
}

fn parse_records_parallel(content: &str) -> Vec<Record> {
    // 小文件不值得起线程
    if content.len() < 1 << 20 {
        return content
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
    }
    let bytes = content.as_bytes();
    let threads = worker_threads();
    let chunk_size = content.len().div_ceil(threads);
    // 按块边界向后对齐到换行符，保证每块都是完整行
    let mut bounds = vec![0usize];
    let mut start = 0usize;
    while start < bytes.len() {
        let mut end = (start + chunk_size).min(bytes.len());
        while end < bytes.len() && bytes[end] != b'\n' {
            end += 1;
        }
        if end < bytes.len() {
            end += 1;
        }
        bounds.push(end);
        start = end;
    }
    std::thread::scope(|s| {
        let handles: Vec<_> = bounds
            .windows(2)
            .map(|w| {
                let slice = &content[w[0]..w[1]];
                s.spawn(move || {
                    slice
                        .lines()
                        .filter_map(|l| serde_json::from_str::<Record>(l).ok())
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        // 按块序 join 合并：保持行序，后行覆盖前行的语义不变
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    })
}

fn parallel_insert(index: &HnswIndex, items: &[(&Vec<f32>, usize)]) {
    let threads = worker_threads();
    if items.len() <= threads * 2 {
        for (embedding, internal_id) in items {
            index.insert((embedding, *internal_id));
        }
        return;
    }
    let chunk = items.len().div_ceil(threads);
    std::thread::scope(|s| {
        for part in items.chunks(chunk) {
            s.spawn(move || {
                for (embedding, internal_id) in part {
                    index.insert((embedding, *internal_id));
                }
            });
        }
    });
}

async fn compact_embeddings(dir: &Path, docs: &HashMap<String, Vec<f32>>) {
    let path = dir.join("embeddings.jsonl");
    let tmp = dir.join("embeddings.jsonl.tmp");
    let mut buf = String::new();
    for (doc_id, embedding) in docs {
        match serde_json::to_string(&Record {
            doc_id: doc_id.clone(),
            embedding: embedding.clone(),
            schema_version: Some(EMBEDDINGS_SCHEMA_VERSION),
            deleted: false,
        }) {
            Ok(line) => {
                buf.push_str(&line);
                buf.push('\n');
            }
            Err(e) => tracing::warn!(
                "embedding compaction serialize failed for {}: {}",
                doc_id,
                e
            ),
        }
    }
    match fs::write(&tmp, buf).await {
        Ok(_) => match fs::rename(&tmp, &path).await {
            Ok(_) => tracing::info!("embedding compaction: rewrote {:?}", path),
            Err(e) => tracing::warn!("embedding compaction rename failed: {}", e),
        },
        Err(e) => tracing::warn!("embedding compaction write failed: {}", e),
    }
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0f64;
    let mut norm_a = 0f64;
    let mut norm_b = 0f64;
    for (x, y) in a.iter().zip(b.iter()) {
        let xf = *x as f64;
        let yf = *y as f64;
        dot += xf * yf;
        norm_a += xf * xf;
        norm_b += yf * yf;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    (dot / (norm_a.sqrt() * norm_b.sqrt())) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_resident_bytes_matches_1536_dim_expectation() {
        // 1536 维（text-embedding-3-small）：每 doc = 1536×4B×2 份 + 1KB ≈ 13.3KB
        assert_eq!(estimate_resident_bytes(1, 1536), 1536 * 4 * 2 + 1024);
        assert_eq!(estimate_resident_bytes(0, 1536), 0);
        // 50_000 条 ≈ 650MB——与 MEM_WARN_DOCS 阈值口径一致
        let est_mb = estimate_resident_bytes(50_000, 1536) / (1 << 20);
        assert!(
            (600..=700).contains(&est_mb),
            "est {est_mb}MB out of expected range"
        );
    }

    #[test]
    fn crossed_mem_stride_only_on_growth_across_boundary() {
        assert!(crossed_mem_stride(9_999, 10_000));
        assert!(crossed_mem_stride(19_999, 20_001));
        assert!(!crossed_mem_stride(10_000, 10_001)); // 档内增长不触发
        assert!(!crossed_mem_stride(10_000, 10_000)); // 重复 upsert 同 doc_id 不触发
        assert!(!crossed_mem_stride(0, 1));
    }

    #[test]
    fn mem_log_warn_threshold_boundary() {
        assert!(!mem_log_is_warn(MEM_WARN_DOCS - 1));
        assert!(mem_log_is_warn(MEM_WARN_DOCS));
        assert!(mem_log_is_warn(MEM_WARN_DOCS + 1));
    }

    /// M47 R1：冷载入张开在 delete 窗口内（代际已 +1、缓存已逐出、目录未删）
    /// 不再复活——单临界区后冷载入相对 delete_agent 的两个同步点（载入前的
    /// 代际快照需 DELETE_GENERATIONS.read、入缓存前的复比需 INDEX_CACHE
    /// .write）都被临界区的写锁挡在外面，放行后载入读到的一定是已删目录。
    /// 用 DELETE_WINDOW_HOOK 屏障把 delete_agent 确定性停在窗口张开位置
    #[tokio::test]
    async fn cold_load_in_delete_window_does_not_resurrect() {
        // 每测试唯一数据目录（thread-local 覆盖，与 tests/vector_test.rs 同方案）
        let tmp = std::env::temp_dir().join(format!(
            "zome-sidecar-r1-window-test-{}",
            std::process::id()
        ));
        std::fs::remove_dir_all(&tmp).ok();
        crate::set_data_dir_override(&tmp);

        // 磁盘预置旧向量：R1 前窗口内的冷载入会读到这份删除前内容并复活它
        let agent = "r1-window-agent";
        let dir = tmp.join("agents").join(agent).join("indices").join("hnsw");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("embeddings.jsonl"),
            concat!(
                r#"{"doc_id":"old-1","embedding":[1.0,0.0],"schemaVersion":2}"#,
                "\n",
                r#"{"doc_id":"old-2","embedding":[0.0,1.0],"schemaVersion":2}"#,
                "\n"
            ),
        )
        .unwrap();

        // 安装窗口屏障：delete_agent 停在"代际+1 后、删目录前"（窗口张开位）
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel::<()>();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel::<()>();
        *DELETE_WINDOW_HOOK.lock().await = Some((entered_tx, resume_rx));

        let delete = tokio::spawn(delete_agent(agent));
        entered_rx
            .await
            .expect("delete_agent must enter the window");

        // 窗口张开中发起冷载入：R1 前此刻快照与复比看到相同代际、载入读到
        // 旧文件——旧向量以新状态复活入缓存；现在首个同步点（缓存读/代际
        // 快照）即被写锁挡住，临界区解除前载入不可能完成
        let mut load = tokio::spawn(get_or_load(agent));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut load)
                .await
                .is_err(),
            "cold load must block on the delete critical section (both write locks held)"
        );

        // 放行删目录；delete 完成后冷载入读到的是已删目录（空索引）
        let _ = resume_tx.send(());
        delete.await.unwrap().unwrap();
        let state = load.await.unwrap().unwrap();
        assert!(
            state.read().await.search(&[1.0, 0.0], 10).is_empty(),
            "旧向量不得在删除后复活"
        );
        // 磁盘层面同样无复活：embeddings.jsonl 未被重建（load_state 的
        // create_dir_all 会重建空目录，目录存在不代表数据复活——事实源是文件）
        assert!(
            !tmp.join("agents")
                .join(agent)
                .join("indices")
                .join("hnsw")
                .join("embeddings.jsonl")
                .exists()
        );

        std::fs::remove_dir_all(&tmp).ok();
    }
}
