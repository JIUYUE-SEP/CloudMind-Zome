"""Unified API Key encryption/decryption using Fernet.

Key management:
- ``CLOUDMIND_ENCRYPTION_KEY`` environment variable (preferred for containers).
- ``<DATA_DIR>/.encryption_key`` file (auto-generated). ``DATA_DIR`` comes from
  ``CLOUDMIND_DATA_DIR`` or defaults to ``~/.cloudmind-zome``.

Encrypted values are prefixed with ``enc:`` so they can be distinguished from
legacy base64-obfuscated or plaintext values. ``decrypt_value()`` is
backward-compatible:
- ``enc:<fernet-token>`` -> decrypt via Fernet.
- valid base64 that decodes to a known API-key prefix -> return decoded value.
- anything else -> return as-is (plaintext compatibility).
"""

from __future__ import annotations

import base64
import binascii
import logging
import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from app.database import DATA_DIR

logger = logging.getLogger(__name__)

ENC_PREFIX = "enc:"
_KEY_FILE: Path = DATA_DIR / ".encryption_key"

# Common API key prefixes used to decide whether a base64-decoded value is a
# real API key (legacy base64 obfuscation) or just a plaintext string.
_API_KEY_PREFIXES = (
    "sk-",
    "sk_",
    "Bearer ",
    "api-",
    "api_",
    "AIza",
    "AKIA",
    "ghp_",
    "dalle",
    "hf_",
)


def _validate_fernet_key(key: bytes) -> None:
    if not key:
        raise ValueError("Encryption key is empty")
    try:
        decoded = base64.urlsafe_b64decode(key)
    except Exception as exc:
        raise ValueError(
            "Encryption key must be a 32-byte URL-safe base64-encoded Fernet key"
        ) from exc
    if len(decoded) != 32:
        raise ValueError(
            f"Encryption key must decode to 32 bytes, got {len(decoded)}"
        )


def get_or_create_encryption_key() -> bytes:
    """Return the Fernet key, creating it on disk if necessary.

    Priority:
    1. ``CLOUDMIND_ENCRYPTION_KEY`` environment variable.
    2. ``<DATA_DIR>/.encryption_key`` file (auto-generated).
    """
    env_key = os.environ.get("CLOUDMIND_ENCRYPTION_KEY", "").strip()
    if env_key:
        key = env_key.encode("utf-8")
        _validate_fernet_key(key)
        return key

    if _KEY_FILE.exists():
        key = _KEY_FILE.read_bytes().strip()
        _validate_fernet_key(key)
        return key

    key = Fernet.generate_key()
    _KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    _KEY_FILE.write_bytes(key)
    try:
        _KEY_FILE.chmod(0o600)
    except Exception:
        # Windows may not support Unix permissions; ignore.
        pass
    logger.info("Generated new encryption key at %s", _KEY_FILE)
    return key


def _get_fernet() -> Fernet:
    return Fernet(get_or_create_encryption_key())


def is_encrypted(value: str | None) -> bool:
    """Return True if *value* carries the ``enc:`` Fernet marker."""
    return bool(value and value.startswith(ENC_PREFIX))


def encrypt_value(plain: str) -> str:
    """Encrypt *plain* and return ``enc:<fernet-token>``.

    Empty strings are returned unchanged so that "no key" stays "no key".
    Already-encrypted input is decrypted first to avoid double encryption.
    """
    if plain is None or plain == "":
        return ""
    # Avoid double-encrypting an already-encrypted value.
    if is_encrypted(plain):
        plain = decrypt_value(plain)
        if plain == "":
            return ""
    token = _get_fernet().encrypt(plain.encode("utf-8")).decode("utf-8")
    return f"{ENC_PREFIX}{token}"


def decrypt_value(token: str) -> str:
    """Decrypt an encrypted value or return legacy values as-is.

    - ``enc:<fernet-token>`` -> Fernet decrypt.
    - valid base64 that decodes to a recognizable API key -> decoded value.
    - otherwise -> returned unchanged (plaintext / unknown format).
    """
    if token is None or token == "":
        return ""

    if is_encrypted(token):
        encrypted = token[len(ENC_PREFIX) :]
        try:
            return _get_fernet().decrypt(encrypted.encode("utf-8")).decode("utf-8")
        except InvalidToken as exc:
            raise ValueError("Invalid or corrupted encrypted token") from exc
        except Exception as exc:
            raise ValueError(f"Decryption failed: {exc}") from exc

    # Legacy base64 obfuscation: try to decode; only use decoded result if it
    # looks like an API key, otherwise treat the token as plaintext.
    try:
        decoded = base64.b64decode(token.encode("utf-8"), validate=True).decode(
            "utf-8"
        )
        if decoded.startswith(_API_KEY_PREFIXES):
            return decoded
    except (binascii.Error, ValueError, UnicodeDecodeError):
        pass

    return token
