use tiktoken_rs::get_bpe_from_model;

pub fn count_tokens(text: &str, model: &str) -> u32 {
    match get_bpe_from_model(model) {
        Ok(bpe) => bpe.encode_with_special_tokens(text).len() as u32,
        Err(_) => (text.chars().count() as u32).div_ceil(4),
    }
}
