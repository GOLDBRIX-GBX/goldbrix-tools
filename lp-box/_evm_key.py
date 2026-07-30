"""Single place that decrypts this LP's EVM key.

The key stays encrypted on disk (PBKDF2-SHA256, 200k iterations, AES-256-CBC) and is
only ever decrypted in memory. Both the daemon and the gateway import this, so there is
exactly one implementation to audit.
"""
import re, json, hashlib
from lp_env import E
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


def load_evm_key():
    env = open(E["ENV_F"]).read()

    def g(k):
        m = re.search(rf'^{k}=(.*)$', env, re.M)
        return m.group(1).strip().strip('"').strip("'") if m else None

    pw, kp = g("EVM_KEY_PASSPHRASE"), g("EVM_KEYSTORE_PATH")
    if not pw or not kp:
        raise RuntimeError("EVM_KEY_PASSPHRASE/EVM_KEYSTORE_PATH missing from the env file")
    buf = open(kp, "rb").read()
    if buf[:8] != b"Salted__":
        raise RuntimeError("keystore: unexpected format")
    salt, ct = buf[8:16], buf[16:]
    ki = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, 200000, dklen=48)
    d = Cipher(algorithms.AES(ki[:32]), modes.CBC(ki[32:48])).decryptor()
    pt = d.update(ct) + d.finalize()
    pt = pt[:-pt[-1]]
    ks = json.loads(pt.decode())
    pk = ks["privateKey"]
    return (pk if pk.startswith("0x") else "0x" + pk), ks["address"]
