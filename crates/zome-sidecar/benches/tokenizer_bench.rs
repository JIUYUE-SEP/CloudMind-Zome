use criterion::{black_box, criterion_group, criterion_main, Criterion};
use zome_sidecar::tokenizer::count_tokens;

fn tokenizer_benchmark(c: &mut Criterion) {
    let text = "hello world ".repeat(100);
    c.bench_function("count_tokens gpt-4 1200 chars", |b| {
        b.iter(|| count_tokens(black_box(&text), black_box("gpt-4")))
    });
}

criterion_group!(benches, tokenizer_benchmark);
criterion_main!(benches);
