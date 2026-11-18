"""Independent check of vectors/receipt-vectors.json (contract v0.4 DRAFT), VCU side only.

Pure Python 3, standard library only: Ed25519 verification and signing written from RFC 8032 section 5.1
(not a crypto library), strict base64url, strict message parser and the release decision. Shares no code
with tools/receipt.js. Also re-derives the test keys from their seeds and re-signs every vector whose
signature was not tampered with (Ed25519 signing is deterministic, so the bytes must be identical).

    python docs/motor-test/contract/tools/check_receipt_vectors.py
"""
import base64, hashlib, json, os, re, struct, sys

# ---------------------------------------------------------------- RFC 8032 Ed25519 (section 5.1)
p = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
d = -121665 * pow(121666, p - 2, p) % p
I = pow(2, (p - 1) // 4, p)

def H(m): return hashlib.sha512(m).digest()
def inv(x): return pow(x, p - 2, p)

def xrecover(y, sign):
    xx = (y * y - 1) * inv(d * y * y + 1) % p
    x = pow(xx, (p + 3) // 8, p)
    if (x * x - xx) % p != 0: x = x * I % p
    if (x * x - xx) % p != 0: return None
    if x == 0 and sign: return None
    if x & 1 != sign: x = p - x
    return x

G = (xrecover(4 * inv(5) % p, 0), 4 * inv(5) % p, 1, xrecover(4 * inv(5) % p, 0) * 4 * inv(5) % p)

def add(P, Q):
    A = (P[1] - P[0]) * (Q[1] - Q[0]) % p; B = (P[1] + P[0]) * (Q[1] + Q[0]) % p
    C = 2 * P[3] * Q[3] * d % p; D = 2 * P[2] * Q[2] % p
    E, F, Gg, Hh = B - A, D - C, D + C, B + A
    return (E * F % p, Gg * Hh % p, F * Gg % p, E * Hh % p)

def mul(s, P):
    Q = (0, 1, 1, 0)
    while s > 0:
        if s & 1: Q = add(Q, P)
        P = add(P, P); s >>= 1
    return Q

def encode(P):
    zi = inv(P[2]); x = P[0] * zi % p; y = P[1] * zi % p
    return int.to_bytes(y | ((x & 1) << 255), 32, 'little')

def decode(b):
    if len(b) != 32: return None
    y = int.from_bytes(b, 'little'); sign = y >> 255; y &= (1 << 255) - 1
    if y >= p: return None
    x = xrecover(y, sign)
    return None if x is None else (x, y, 1, x * y % p)

def equal(P, Q):
    return (P[0] * Q[2] - Q[0] * P[2]) % p == 0 and (P[1] * Q[2] - Q[1] * P[2]) % p == 0

def secret_expand(seed):
    h = H(seed); a = int.from_bytes(h[:32], 'little')
    a &= (1 << 254) - 8; a |= 1 << 254
    return a, h[32:]

def public_from_seed(seed): return encode(mul(secret_expand(seed)[0], G))

def sign(seed, msg):
    a, prefix = secret_expand(seed); A = encode(mul(a, G))
    r = int.from_bytes(H(prefix + msg), 'little') % L
    R = encode(mul(r, G))
    k = int.from_bytes(H(R + A + msg), 'little') % L
    return R + int.to_bytes((r + k * a) % L, 32, 'little')

def verify(pub, msg, sig):
    if len(sig) != 64: return False
    A = decode(pub); R = decode(sig[:32])
    if A is None or R is None: return False
    s = int.from_bytes(sig[32:], 'little')
    if s >= L: return False
    k = int.from_bytes(H(sig[:32] + pub + msg), 'little') % L
    return equal(mul(s, G), add(R, mul(k, A)))

# RFC 8032 section 7.1, TEST 1 (empty message) - proves the arithmetic before trusting it.
_sk = bytes.fromhex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
assert public_from_seed(_sk).hex() == 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
assert sign(_sk, b'').hex() == ('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155'
                                '5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b')

# ---------------------------------------------------------------- receipt (spec section 4-6)
MAGIC = b'MTRCPT1\x00'
FINAL = {1: 'COMPLETED', 2: 'ABORTED', 3: 'FAULT'}
OUTCOME = {1: 'PASS', 2: 'FAIL', 3: 'INCOMPLETE', 4: 'INVALID'}
STOP = {1: 'RAMP_COMPLETE', 2: 'OPERATOR_STOP', 3: 'HB_LOSS', 4: 'FAULT', 5: 'POWER_LOSS', 6: 'CONFIG_CANCELLED'}
ID_RE = re.compile(r'[A-Za-z0-9._-]{1,32}')

def b64url_strict(s):
    if not isinstance(s, str) or not re.fullmatch(r'[A-Za-z0-9_-]*', s) or len(s) % 4 == 1: return None
    b = base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))
    return b if base64.urlsafe_b64encode(b).rstrip(b'=').decode() == s else None

def uuid_str(b):
    h = b.hex(); return f'{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}'

def parse(b):
    if len(b) < 8 or b[:8] != MAGIC: return None, 'BAD_VERSION' if len(b) >= 8 else 'MALFORMED_MESSAGE'
    if len(b) < 172: return None, 'MALFORMED_MESSAGE'
    if b[68] not in FINAL or b[69] not in OUTCOME or b[70] not in STOP or b[71] & 0xF0: return None, 'MALFORMED_MESSAGE'
    vl = b[168]
    if not 1 <= vl <= 32 or len(b) < 170 + vl: return None, 'MALFORMED_MESSAGE'
    bl = b[169 + vl]
    if not 1 <= bl <= 32 or len(b) != 170 + vl + bl: return None, 'MALFORMED_MESSAGE'
    vcu, boot = b[169:169 + vl], b[170 + vl:]
    if not (ID_RE.fullmatch(vcu.decode('latin1')) and ID_RE.fullmatch(boot.decode('latin1'))): return None, 'MALFORMED_MESSAGE'
    sample_count, held, stored = struct.unpack_from('<III', b, 56)
    return {
        'key_id': b[8:16].hex(), 'test_id': uuid_str(b[16:32]), 'sample_count': sample_count, 'held_count': held,
        'stored_sample_count': stored, 'final_state': FINAL[b[68]], 'outcome': OUTCOME[b[69]], 'stop_reason': STOP[b[70]],
        'flags': b[71], 'run_digest': 'sha256:' + b[72:104].hex(), 'samples_digest': 'sha256:' + b[104:136].hex(),
        'vcu_id': vcu.decode('latin1'), 'origin_boot_id': boot.decode('latin1'),
    }, None

def decide(signed, keyring, man):
    msg_b, sig = b64url_strict(signed['message']), b64url_strict(signed['signature'])
    if msg_b is None or sig is None or len(sig) != 64: return 'MALFORMED_ENCODING'
    m, why = parse(msg_b)
    if m is None: return why
    key = next((k for k in keyring if k['key_id'] == m['key_id']), None)
    if key is None: return 'UNKNOWN_KEY'
    if not verify(b64url_strict(key['public_key']), msg_b, sig): return 'BAD_SIGNATURE'
    f, started = m['flags'], bool(m['flags'] & 8)
    if (bool(f & 1) != (m['samples_digest'] == m['run_digest']) or bool(f & 2) != (m['stored_sample_count'] == m['held_count'])
            or bool(f & 4) != (m['held_count'] == m['sample_count']) or m['held_count'] > m['sample_count']
            or m['stored_sample_count'] > m['held_count']
            or (not started and (m['sample_count'] != 0 or m['stop_reason'] != 'CONFIG_CANCELLED'
                                 or m['final_state'] != 'ABORTED' or m['outcome'] != 'INCOMPLETE'))
            or (started and m['stop_reason'] == 'CONFIG_CANCELLED')):
        return 'FLAGS_INCONSISTENT'
    # lifecycle combinations (spec section 6, step 6)
    allowed_stop = {'COMPLETED': {'RAMP_COMPLETE'}, 'ABORTED': {'OPERATOR_STOP', 'HB_LOSS', 'POWER_LOSS', 'CONFIG_CANCELLED'},
                    'FAULT': {'FAULT'}}
    verdict = m['outcome'] != 'INCOMPLETE'
    if m['stop_reason'] not in allowed_stop[m['final_state']] or (verdict and (m['final_state'] != 'COMPLETED' or f & 7 != 7)):
        return 'LIFECYCLE_INCONSISTENT'
    if m['test_id'] != man['test_id']: return 'TEST_ID_MISMATCH'
    if m['vcu_id'] != man['vcu_id']: return 'VCU_ID_MISMATCH'
    if m['origin_boot_id'] != man['origin_boot_id']: return 'BOOT_ID_MISMATCH'
    if (m['run_digest'] != man['run_digest'] or m['sample_count'] != man['sample_count']
            or m['held_count'] != man['held_count'] or started != man['started']
            or m['final_state'] != man['final_state'] or m['stop_reason'] != man['stop_reason']): return 'MANIFEST_MISMATCH'
    if m['stored_sample_count'] != m['held_count']: return 'SHORTFALL'
    if m['samples_digest'] != m['run_digest']: return 'DIGEST_MISMATCH'
    return 'RELEASE'

def main():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'vectors', 'receipt-vectors.json')
    doc = json.load(open(path, encoding='utf-8'))
    seeds = {}
    for name, k in doc['test_keys'].items():
        seed = hashlib.sha256(k['seed_label'].encode()).digest()
        assert seed.hex() == k['seed_hex'], f'key {name}: seed'
        pub = public_from_seed(seed)
        assert pub.hex() == k['public_key_hex'], f'key {name}: public key'
        assert hashlib.sha256(pub).digest()[:8].hex() == k['key_id'], f'key {name}: key_id'
        seeds[k['key_id']] = seed
    fails = 0
    for v in doc['vectors']:
        got = decide(v['signed_receipt'], doc['vcu_keyring'], v['vcu_manifest'])
        ok = got == v['expected']['reason'] and (got == 'RELEASE') == v['expected']['release']
        # Re-sign untampered messages: the signature bytes must be identical (deterministic Ed25519).
        msg = bytes.fromhex(v['message_hex']); sig = b64url_strict(v['signed_receipt']['signature'])
        if v['expected']['reason'] in ('RELEASE', 'TEST_ID_MISMATCH', 'VCU_ID_MISMATCH', 'BOOT_ID_MISMATCH', 'MANIFEST_MISMATCH', 'SHORTFALL', 'DIGEST_MISMATCH', 'FLAGS_INCONSISTENT', 'LIFECYCLE_INCONSISTENT'):
            ok = ok and sig == sign(seeds[msg[8:16].hex()], msg)
        fails += not ok
        print(('PASS' if ok else 'FAIL'), v['id'], got)
    print(f"{len(doc['vectors']) - fails}/{len(doc['vectors'])} vectors agree (RFC 8032 test 1 passed first)")
    sys.exit(1 if fails else 0)

if __name__ == '__main__':
    main()
