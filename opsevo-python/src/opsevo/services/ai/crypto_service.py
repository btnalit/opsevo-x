"""Crypto service — thin wrapper around utils/crypto for DI.

Requirements: 11.4
"""

from __future__ import annotations

from opsevo.utils.crypto import aes_decrypt, aes_encrypt


class CryptoService:
    def __init__(self, secret_key: str):
        self._key = secret_key

    def encrypt(self, plaintext: str) -> str:
        return aes_encrypt(plaintext, self._key)

    def decrypt(self, ciphertext: str) -> str:
        return aes_decrypt(ciphertext, self._key)
