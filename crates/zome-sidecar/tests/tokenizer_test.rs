use zome_sidecar::tokenizer::count_tokens;

#[test]
fn test_tokenizer_known_model() {
    let count = count_tokens("hello world", "gpt-4");
    assert!(count > 0);
}

#[test]
fn test_tokenizer_fallback() {
    let count = count_tokens("hello world", "unknown-model");
    assert_eq!(count, 3);
}
