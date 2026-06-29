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
}

impl VectorIndexState {
    pub async fn upsert(&mut self, doc_id: &str, embedding: &[f32]) {
        self.docs.insert(doc_id.to_string(), embedding.to_vec());
        self.index = build_map(&self.docs);
        self.persist().await;
    }

    pub fn search(&self, query: &[f32], top_k: usize) -> Vec<(String, f32)> {
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

    async fn persist(&self) {
        let path = self.dir.join("embeddings.jsonl");
        let tmp = self.dir.join("embeddings.jsonl.tmp");

        let mut lines = Vec::new();
        for (doc_id, embedding) in &self.docs {
            if let Ok(line) = serde_json::to_string(&Record {
                doc_id: doc_id.clone(),
                embedding: embedding.clone(),
            }) {
                lines.push(line);
            }
        }

        let content = lines.join("\n");
        let Some(parent) = tmp.parent() else {
            return;
        };
        if fs::create_dir_all(parent).await.is_err() {
            return;
        }
        let mut file = match fs::File::create(&tmp).await {
            Ok(f) => f,
            Err(_) => return,
        };
        if file.write_all(content.as_bytes()).await.is_err() {
            return;
        }
        if file.sync_all().await.is_err() {
            return;
        }
        fs::rename(tmp, path).await.ok();
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
    let state = Arc::new(RwLock::new(VectorIndexState { dir, docs, index }));
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
