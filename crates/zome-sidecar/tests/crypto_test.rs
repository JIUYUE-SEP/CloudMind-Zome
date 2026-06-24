use std::path::PathBuf;
use std::sync::Mutex;

use zome_sidecar::crypto::{decrypt, encrypt};

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn temp_data_dir() -> PathBuf {
    let tmp = std::env::temp_dir().join(format!("zome-sidecar-crypto-test-{}", std::process::id()));
    unsafe { std::env::set_var("CLOUDMIND_DATA_DIR", &tmp) };
    tmp
}

#[test]
fn test_crypto_roundtrip() {
    let _lock = ENV_LOCK.lock().unwrap();
    let tmp = temp_data_dir();
    let plaintext = "hello world";
    let ciphertext = encrypt(plaintext).expect("encrypt");
    let decrypted = decrypt(&ciphertext).expect("decrypt");
    assert_eq!(decrypted, plaintext);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn test_crypto_utf8() {
    let _lock = ENV_LOCK.lock().unwrap();
    let tmp = temp_data_dir();
    let plaintext = "你好世界 🌍";
    let ciphertext = encrypt(plaintext).expect("encrypt");
    let decrypted = decrypt(&ciphertext).expect("decrypt");
    assert_eq!(decrypted, plaintext);
    let _ = std::fs::remove_dir_all(&tmp);
}
