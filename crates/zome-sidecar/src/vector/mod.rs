use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use instant_distance::{Builder, HnswMap, Point, Search};

use crate::data_dir;

#[derive(Clone)]
struct Embedding(Vec<f32>);

impl Point for Embedding {
    fn distance(&self, other: &Self) -> f32 {
        self.0
            .iter()
            .zip(other.0.iter())
            .map(|(a, b)| (a - b).powi(2))
            .sum::<f32>()
            .sqrt()
    }
}

pub struct VectorIndex {
    #[allow(dead_code)]
    agent_id: String,
    dir: PathBuf,
    docs: HashMap<String, Vec<f32>>,
    map: Option<HnswMap<Embedding, String>>,
}

impl VectorIndex {
    pub fn new(agent_id: &str) -> Self {
        let dir = data_dir()
            .join("agents")
            .join(agent_id)
            .join("indices")
            .join("hnsw");
        fs::create_dir_all(&dir).ok();

        let path = dir.join("embeddings.jsonl");
        let mut docs = HashMap::new();
        if let Ok(content) = fs::read_to_string(&path) {
            for line in content.lines() {
                if let Ok(record) = serde_json::from_str::<Record>(line) {
                    docs.insert(record.doc_id, record.embedding);
                }
            }
        }

        let map = build_map(&docs);
        Self {
            agent_id: agent_id.to_string(),
            dir,
            docs,
            map,
        }
    }

    pub fn upsert(&mut self, doc_id: &str, embedding: &[f32]) {
        self.docs.insert(doc_id.to_string(), embedding.to_vec());
        self.map = build_map(&self.docs);
        self.persist();
    }

    pub fn search(&self, query: &[f32], top_k: usize) -> Vec<(String, f32)> {
        let Some(map) = &self.map else {
            return Vec::new();
        };
        let point = Embedding(query.to_vec());
        let mut search = Search::default();
        map.search(&point, &mut search)
            .map(|result| (result.value.clone(), result.distance))
            .take(top_k)
            .collect()
    }

    fn persist(&self) {
        let path = self.dir.join("embeddings.jsonl");
        let mut lines = Vec::new();
        for (doc_id, embedding) in &self.docs {
            if let Ok(line) = serde_json::to_string(&Record {
                doc_id: doc_id.clone(),
                embedding: embedding.clone(),
            }) {
                lines.push(line);
            }
        }
        fs::write(path, lines.join("\n")).ok();
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Record {
    doc_id: String,
    embedding: Vec<f32>,
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
