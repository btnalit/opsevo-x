"""AES encryption / decryption utilities.

Provides ``encrypt_aes`` and ``decrypt_aes`` using AES-256-CBC with PKCS7
padding via the ``cryptography`` library.  The ciphertext is returned as a
URL-safe base64 string with the IV prepended.

Requirements: 20.3
"""

from __future__ import annotations

import base64
import hashlib
import os

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7


def _derive_key(key: str) -> bytes:
    """Derive a 32-byte AES-256 key from an arbitrary string via SHA-256."""
    return hashlib.sha256(key.encode("utf-8")).digest()


def encrypt_aes(plaintext: str, key: str) -> str:
    """Encrypt *plaintext* with AES-256-CBC and return base64-encoded result.

    The output format is ``base64(iv + ciphertext)`` where *iv* is 16 bytes.

    Raises ``ValueError`` if *plaintext* is empty.
    """
    if not plaintext:
        raise ValueError("Cannot encrypt empty string")

    derived = _derive_key(key)
    iv = os.urandom(16)

    padder = PKCS7(128).padder()
    padded = padder.update(plaintext.encode("utf-8")) + padder.finalize()

    cipher = Cipher(algorithms.AES(derived), modes.CBC(iv))
    encryptor = cipher.encryptor()
    ct = encryptor.update(padded) + encryptor.finalize()

    return base64.b64encode(iv + ct).decode("ascii")


def decrypt_aes(ciphertext: str, key: str) -> str:
    """Decrypt a base64-encoded AES-256-CBC ciphertext.

    Expects the format produced by ``encrypt_aes``: ``base64(iv + ciphertext)``.

    Raises ``ValueError`` if *ciphertext* is empty or decryption fails.
    """
    if not ciphertext:
        raise ValueError("Cannot decrypt empty string")

    derived = _derive_key(key)

    try:
        raw = base64.b64decode(ciphertext)
    except Exception as exc:
        raise ValueError("Invalid base64 ciphertext") from exc

    if len(raw) < 32:  # 16-byte IV + at least 16-byte block
        raise ValueError("Ciphertext too short")

    iv = raw[:16]
    ct = raw[16:]

    cipher = Cipher(algorithms.AES(derived), modes.CBC(iv))
    decryptor = cipher.decryptor()
    padded = decryptor.update(ct) + decryptor.finalize()

    unpadder = PKCS7(128).unpadder()
    try:
        plaintext = unpadder.update(padded) + unpadder.finalize()
    except Exception as exc:
        raise ValueError("Decryption failed: invalid ciphertext or wrong key") from exc

    return plaintext.decode("utf-8")


# Aliases for backward compatibility
aes_encrypt = encrypt_aes
aes_decrypt = decrypt_aes
