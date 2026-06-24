use std::fs;
use std::io::Write;
use std::path::PathBuf;

use anyhow::{Context, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};

use crate::data_dir;

const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const KEY_LEN: usize = 32;

pub fn encrypt(plaintext: &str) -> anyhow::Result<String> {
    let key = master_key()?;
    let nonce_bytes = random_bytes(NONCE_LEN)?;
    let nonce_arr: [u8; NONCE_LEN] = nonce_bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid nonce length"))?;
    let nonce = Nonce::assume_unique_for_key(nonce_arr);

    let key_less = build_key(&key)?;
    let mut in_out = plaintext.as_bytes().to_vec();
    key_less
        .seal_in_place_append_tag(nonce, Aad::empty(), &mut in_out)
        .map_err(|_| anyhow::anyhow!("encryption failed"))?;

    let mut result = Vec::with_capacity(NONCE_LEN + in_out.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&in_out);

    Ok(STANDARD.encode(&result))
}

pub fn decrypt(ciphertext: &str) -> anyhow::Result<String> {
    let key = master_key()?;
    let bytes = STANDARD.decode(ciphertext).context("invalid base64")?;
    if bytes.len() < NONCE_LEN + TAG_LEN {
        bail!("ciphertext too short");
    }

    let (nonce_bytes, rest) = bytes.split_at(NONCE_LEN);
    let (encrypted, tag_bytes) = rest.split_at(rest.len() - TAG_LEN);

    let nonce_arr: [u8; NONCE_LEN] = nonce_bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid nonce length"))?;
    let nonce = Nonce::assume_unique_for_key(nonce_arr);

    let key_less = build_key(&key)?;
    let mut in_out = encrypted.to_vec();
    in_out.extend_from_slice(tag_bytes);
    let plaintext = key_less
        .open_in_place(nonce, Aad::empty(), &mut in_out)
        .map_err(|_| anyhow::anyhow!("decryption failed"))?;

    String::from_utf8(plaintext.to_vec()).context("invalid utf8 plaintext")
}

fn build_key(key: &[u8]) -> anyhow::Result<LessSafeKey> {
    if key.len() != KEY_LEN {
        bail!("invalid key length: expected {KEY_LEN}, got {}", key.len());
    }
    let unbound = UnboundKey::new(&AES_256_GCM, key).map_err(|_| anyhow::anyhow!("invalid key"))?;
    Ok(LessSafeKey::new(unbound))
}

fn master_key() -> anyhow::Result<Vec<u8>> {
    if let Ok(key_b64) = std::env::var("ZOME_MASTER_KEY") {
        return STANDARD.decode(key_b64).context("invalid ZOME_MASTER_KEY");
    }

    let path = master_key_path();
    if let Ok(content) = fs::read_to_string(&path) {
        let trimmed = content.trim();
        if !trimmed.is_empty() {
            return STANDARD.decode(trimmed).context("invalid master key file");
        }
    }

    let key = random_bytes(KEY_LEN)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let encoded = STANDARD.encode(&key);

    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&path)?;
        file.write_all(encoded.as_bytes())?;
        fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .custom_flags(FILE_ATTRIBUTE_HIDDEN)
            .open(&path)?;
        file.write_all(encoded.as_bytes())?;
        let mut perms = fs::metadata(&path)?.permissions();
        perms.set_readonly(true);
        fs::set_permissions(&path, perms)?;
    }

    Ok(key)
}

fn master_key_path() -> PathBuf {
    data_dir().join(".master_key")
}

fn random_bytes(len: usize) -> anyhow::Result<Vec<u8>> {
    let rng = SystemRandom::new();
    let mut buf = vec![0u8; len];
    rng.fill(&mut buf)
        .map_err(|_| anyhow::anyhow!("rng failed"))?;
    Ok(buf)
}
