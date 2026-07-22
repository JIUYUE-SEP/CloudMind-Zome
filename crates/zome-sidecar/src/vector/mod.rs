use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use instant_distance::{Builder, HnswMap, Point, Search};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;

use crate::data_dir;
use crate::sanitize_agent_id;

#[derive(Clone)]
struct Embedding(Vec<f32>);

impl Point for Embedding {
    fn distance(&self, other: &Self) -> f32 {
        1.0 - cosine_similarity(&self.0, &other.0)
    }
}

pub struct VectorIndexState {
    dir: PathBuf,
    docs: HashMap<String, Vec<f32>>,
    index: Option<HnswMap<Embedding, String>>,
    /// 有未入索引的 upsert：search 前惰性重建一次，避免每条消息 O(n) 重建
    dirty: bool,
}

impl VectorIndexState {
    pub async fn upsert(&mut self, doc_id: &str, embedding: &[f32]) {
        self.docs.insert(doc_id.to_string(), embedding.to_vec());
        self.dirty = true;
        self.persist_append(doc_id, embedding).await;
    }

    pub fn search(&mut self, query: &[f32], top_k: usize) -> Vec<(String, f32)> {
        // 惰性重建：一轮对话 N 次 upsert 只在此重建一次（原每次 upsert 全量重建）
        if self.dirty {
            self.index = build_map(&self.docs);
            self.dirty = false;
        }
        if let Some(index) = &self.index {
            let point = Embedding(query.to_vec());
            let mut search = Search::default();
            let results: Vec<_> = index
                .search(&point, &mut search)
                .map(|result| (result.value.clone(), result.distance))
                .take(top_k)
                .collect();
            if !results.is_empty() || self.docs.len() >= 2 {
                return results;
            }
        }
        self.linear_search(query, top_k)
    }

    fn linear_search(&self, query: &[f32], top_k: usize) -> Vec<(String, f32)> {
        if top_k == 0 || self.docs.is_empty() {
            return Vec::new();
        }
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

    let mut cache = INDEX_CACHE.write().await;
    if let Some(state) = cache.get(&agent_id) {
        return Ok(Arc::clone(state));
    }

    let dir = data_dir()
        .join("agents")
        .join(&agent_id)
        .join("indices")
        .join("hnsw");
    fs::create_dir_all(&dir).await.ok();

    let path = dir.join("embeddings.jsonl");
    let mut docs = HashMap::new();
    if let Ok(content) = fs::read_to_string(&path).await {
        for line in content.lines() {
            if let Ok(record) = serde_json::from_str::<Record>(line) {
                docs.insert(record.doc_id, record.embedding);
            }
        }
    }

    let index = build_map(&docs);
    let state = Arc::new(RwLock::new(VectorIndexState {
        dir,
        docs,
        index,
        dirty: false,
    }));
    cache.insert(agent_id, Arc::clone(&state));
    Ok(state)
}

fn build_map(docs: &HashMap<String, Vec<f32>>) -> Option<HnswMap<Embedding, String>> {
    if docs.len() < 2 {
        return None;
    }
    let mut points = Vec::with_capacity(docs.len());
    let mut values = Vec::with_capacity(docs.len());
    for (id, emb) in docs {
        points.push(Embedding(emb.clone()));
        values.push(id.clone());
    }
    Some(Builder::default().build(points, values))
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
