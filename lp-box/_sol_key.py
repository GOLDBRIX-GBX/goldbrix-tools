from lp_env import E
"""GOLDBRIX · _load_solana_key — decripteaza cheia treasury Solana in RAM.
Model identic _load_treasury_key (EVM): OpenSSL Salted__ + PBKDF2-SHA256 200k + AES-256-CBC.
Returneaza array-ul secret de 64 bytes (formatul Solana Keypair), NU il lasa pe disc.
Aceeasi parola EVM_KEY_PASSPHRASE (o singura identitate calda)."""
import re, hashlib, json
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

def load_solana_secret(env_path=E["ENV_F"]):
    env = open(env_path).read()
    def g(k):
        m = re.search(rf'^{k}=(.*)$', env, re.M)
        return m.group(1).strip().strip('"').strip("'") if m else None
    pw = g("EVM_KEY_PASSPHRASE"); kp = g("SOLANA_KEYSTORE_PATH")
    if not pw or not kp:
        raise RuntimeError("EVM_KEY_PASSPHRASE/SOLANA_KEYSTORE_PATH lipsa in .env")
    buf = open(kp, "rb").read()
    if buf[:8] != b"Salted__":
        raise RuntimeError("solana keystore: format openssl invalid")
    salt = buf[8:16]; ct = buf[16:]
    ki = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, 200000, dklen=48)
    d = Cipher(algorithms.AES(ki[:32]), modes.CBC(ki[32:48])).decryptor()
    pt = d.update(ct) + d.finalize(); pt = pt[:-pt[-1]]   # strip PKCS7 padding
    secret = json.loads(pt.decode())
    if not isinstance(secret, list) or len(secret) != 64:
        raise RuntimeError(f"solana secret format gresit: len={len(secret) if isinstance(secret,list) else 'N/A'}")
    return secret
