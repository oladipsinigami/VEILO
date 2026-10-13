import hashlib
import os
import ssl

print("kernel:", os.uname().release.split("-")[0])
print("openssl:", ssl.OPENSSL_VERSION)
try:
    h = hashlib.new("ripemd160")
    h.update(b"abc")
    print("ripemd160(abc):", h.hexdigest())
except Exception as exc:
    print("ripemd160 UNAVAILABLE:", type(exc).__name__, exc)