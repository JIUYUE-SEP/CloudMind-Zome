use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use tiktoken_rs::{CoreBPE, get_bpe_from_model};

/// get_bpe_from_model 每次都重新解析 rank 文件构造 BPE（非 singleton），
/// 按 model 缓存一份共享实例，昂贵构造只发生一次。
static BPE_CACHE: LazyLock<Mutex<HashMap<String, Arc<Mutex<CoreBPE>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn bpe_for_model(model: &str) -> Option<Arc<Mutex<CoreBPE>>> {
    let mut cache = BPE_CACHE.lock().ok()?;
    if let Some(bpe) = cache.get(model) {
        return Some(Arc::clone(bpe));
    }
    let bpe = Arc::new(Mutex::new(get_bpe_from_model(model).ok()?));
    cache.insert(model.to_string(), Arc::clone(&bpe));
    Some(bpe)
}

pub fn count_tokens(text: &str, model: &str) -> u32 {
    let fallback = || (text.chars().count() as u32).div_ceil(4);
    match bpe_for_model(model) {
        Some(bpe) => match bpe.lock() {
            Ok(bpe) => bpe.encode_with_special_tokens(text).len() as u32,
            Err(_) => fallback(),
        },
        None => fallback(),
    }
}
