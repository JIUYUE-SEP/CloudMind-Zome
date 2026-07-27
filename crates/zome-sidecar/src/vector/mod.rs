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

/// embeddings.jsonl 启动 compaction（M9）：行数超过唯一文档数 2 倍且超过
/// 该下限才重写，避免小文件无意义 IO
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
/// 每行记录带 schemaVersion 字段；无字段的旧行视为 v1，高于当前版本显式报错）
const EMBEDDINGS_SCHEMA_VERSION: u32 = 1;

type HnswIndex = Hnsw<'static, f32, DistCosine>;

pub struct VectorIndexState {
    dir: PathBuf,
    /// 索引维度：首个向量的维度即全索引维度（0 = 空索引未定维）。
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
}

impl VectorIndexState {
    pub async fn upsert(&mut self, doc_id: &str, embedding: &[f32]) {
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
    /// 文件为 append-only：同 doc_id 后行覆盖前行（加载时按行序 insert 去重）。
    /// 不逐条 fsync——嵌入索引是从消息派生的冗余数据，OS 级崩溃丢失少量尾部可接受；
    /// 失败仅告警，不影响主链路。
    async fn persist_append(&self, doc_id: &str, embedding: &[f32]) {
        let path = self.dir.join("embeddings.jsonl");
        let line = match serde_json::to_string(&Record {
            doc_id: doc_id.to_string(),
            embedding: embedding.to_vec(),
            schema_version: Some(EMBEDDINGS_SCHEMA_VERSION),
        }) {
            Ok(l) => l + "\n",
            Err(e) => {
                tracing::warn!("embedding serialize failed for {}: {}", doc_id, e);
                return;
            }
        };
        if let Err(e) = fs::create_dir_all(&self.dir).await {
            tracing::warn!("embedding dir create failed: {}", e);
            return;
        }
        let mut file = match fs::OpenOptions::new().create(true).append(true).open(&path).await {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!("embedding file open failed: {}", e);
                return;
            }
        };
        if let Err(e) = file.write_all(line.as_bytes()).await {
            tracing::warn!("embedding append failed for {}: {}", doc_id, e);
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Record {
    doc_id: String,
    embedding: Vec<f32>,
    /// 格式版本（P1-1）：旧行无此字段（反序列化为 None，视为 v1）；
    /// 写入时盖当前版本戳；高于当前版本加载时显式报错，不静默跳过
    #[serde(rename = "schemaVersion", default)]
    schema_version: Option<u32>,
}

/// 记录级版本迁移（P1-1，与 engine 侧 MigrationChain 同一设计）：把 from_version
/// 的记录逐级迁到当前版本。当前只有 v1，无实际迁移步骤；未来 v1→v2 迁移作为
/// 第一级加在这里，逐级链式应用。
fn migrate_record(record: Record, from_version: u32) -> Record {
    debug_assert!(from_version >= 1 && from_version <= EMBEDDINGS_SCHEMA_VERSION);
    let _ = from_version;
    record
}

static INDEX_CACHE: std::sync::LazyLock<RwLock<HashMap<String, Arc<RwLock<VectorIndexState>>>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

pub async fn get_or_load(agent_id: &str) -> anyhow::Result<Arc<RwLock<VectorIndexState>>> {
    let agent_id = sanitize_agent_id(agent_id)?;

    {
        let cache = INDEX_CACHE.read().await;
        if let Some(state) = cache.get(&agent_id) {
            return Ok(Arc::clone(state));
        }
    }

    // 重活（读盘 + JSON 解析 + 并行建索引）在缓存写锁外完成：
    // 避免一个 agent 的冷载入（万条级秒级）阻塞其他 agent 的首次加载
    let built = load_state(&agent_id).await?;

    let mut cache = INDEX_CACHE.write().await;
    // 并发竞争加载：先到者生效，重复构建直接丢弃
    if let Some(state) = cache.get(&agent_id) {
        return Ok(Arc::clone(state));
    }
    cache.insert(agent_id, Arc::clone(&built));
    Ok(built)
}

/// 删除 agent 的全部向量数据（P1-3，review M3）：逐出 INDEX_CACHE + 删除磁盘
/// indices 目录。此前缓存进程常驻无失效入口：删除 agent 后同名重建会命中旧向量
/// 全集，旧记忆复活并随新 upsert 重新落盘。
/// 幂等：agent 不存在（缓存/磁盘都没有）同样返回 Ok。
pub async fn delete_agent(agent_id: &str) -> anyhow::Result<()> {
    let agent_id = sanitize_agent_id(agent_id)?;

    let removed = {
        let mut cache = INDEX_CACHE.write().await;
        cache.remove(&agent_id)
    };
    if let Some(state) = removed {
        // 持写锁删目录：等在飞 upsert/search 全部完成，且删除期间旧句柄的新
        // upsert 被挡在锁外（否则在飞 upsert 会在目录删除后经 persist_append
        // 重建文件，同名重建又读到旧向量）。锁释放后再经旧句柄 upsert 理论上
        // 仍会重建文件——engine 删除 agent 时已先停掉其流量（worker 随 onChange
        // 移除），该窗口仅存于引擎之外的直接调用方。
        let _guard = state.write().await;
        return remove_index_dir(&agent_id).await;
    }

    remove_index_dir(&agent_id).await
}

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
    let content = fs::read_to_string(&path).await.unwrap_or_default();
    let line_count = content.lines().count();
    if !content.is_empty() {
        // 并行解析：按行边界切块多线程 JSON 解析（万条级 44MB 解析是冷载入主要成本）
        for record in parse_records_parallel(&content) {
            // 版本字段（P1-1）：无 schemaVersion 的旧行视为 v1；高于当前版本显式
            // 报错（engine 侧收到错误后 L4 降级并明确告知，不静默读空）；旧版按需迁移
            let version = record.schema_version.filter(|v| *v >= 1).unwrap_or(1);
            if version > EMBEDDINGS_SCHEMA_VERSION {
                return Err(anyhow::anyhow!(
                    "embeddings.jsonl schema version too new for agent {}: v{}, this sidecar supports up to v{}; upgrade the sidecar (file left unchanged)",
                    agent_id,
                    version,
                    EMBEDDINGS_SCHEMA_VERSION
                ));
            }
            let record = migrate_record(record, version);
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
    // 写 tmp + rename 原子替换，崩溃不留半截文件
    if line_count > docs.len().saturating_mul(2).max(COMPACTION_MIN_LINES) {
        compact_embeddings(&dir, &docs).await;
    }

    // 启动载入：先固定内部 id 顺序，再并行插入（hnsw_rs 的 insert 为 &self 且
    // Sync，官方支持并发插入）。万条规模串行插入秒级，并行后压到亚秒，
    // 避免 sidecar 重启后首次 search 撞 TS 客户端 3000ms deadline
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
    for (doc_id, embedding) in &docs {
        let internal_id = ids.len();
        ids.push(doc_id.clone());
        doc_ids.insert(doc_id.clone(), internal_id);
        items.push((embedding, internal_id));
    }
    parallel_insert(&index, &items);

    let state = VectorIndexState {
        dir,
        dim,
        docs,
        index,
        ids,
        doc_ids,
    };
    // 冷载入内存观测（P1-5）：每次启动记录一次全量驻留估算（含文件体积）
    state.log_mem_stats(Some(content.len() as u64));
    Ok(Arc::new(RwLock::new(state)))
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
        }) {
            Ok(line) => {
                buf.push_str(&line);
                buf.push('\n');
            }
            Err(e) => tracing::warn!("embedding compaction serialize failed for {}: {}", doc_id, e),
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
        assert!((600..=700).contains(&est_mb), "est {}MB out of expected range", est_mb);
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
}
