"""Independent check of vectors/receipt-v2-vectors.json (MTRCPT2, contract v0.5 DRAFT), VCU side only.

Pure Python 3, standard library only. Ed25519 (RFC 8032, plain Python) and strict base64url are imported from
check_receipt_vectors.py in this folder; the MTRCPT2 parser and the release decision are written here and share no
code with tools/receipt.js or tools/receipt_v2.js. Re-derives the test keys from their seeds and re-signs every
vector whose message and signature were not tampered with (deterministic Ed25519: the bytes must be identical).
Runs the MTRCPT1 check (check_receipt_vectors.py, 52 vectors) first.

    python docs/motor-test/contract/tools/check_receipt_v2_vectors.py
"""
import hashlib, json, os, re, struct, sys

sys.dont_write_bytecode = True  # no __pycache__ next to the contract files
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_receipt_vectors as v1  # noqa: E402  (RFC 8032 test 1 is asserted on import)
from check_receipt_vectors import b64url_strict, public_from_seed, sign, verify  # noqa: E402

MAGIC2 = b'MTRCPT2\x00'
FINAL = {1: 'COMPLETED', 2: 'ABORTED', 3: 'FAULT'}
OUTCOME = {1: 'PASS', 2: 'FAIL', 3: 'INCOMPLETE', 4: 'INVALID'}
STOP = {1: 'RAMP_COMPLETE', 2: 'OPERATOR_STOP', 3: 'HB_LOSS', 4: 'FAULT', 5: 'POWER_LOSS', 6: 'CONFIG_CANCELLED'}
ALLOWED_STOP = {'COMPLETED': {'RAMP_COMPLETE'}, 'ABORTED': {'OPERATOR_STOP', 'HB_LOSS', 'CONFIG_CANCELLED'},
                'FAULT': {'FAULT', 'POWER_LOSS'}}
IDENT = re.compile(r'[A-Za-z0-9._-]{1,32}')
IDS_AT = 249  # first identifier length byte


def uuid_str(b):
    h = b.hex(); return f'{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}'


def parse_v2(b):
    """Strict MTRCPT2 parse: returns (fields, None) or (None, reason)."""
    if len(b) < 8: return None, 'MALFORMED_MESSAGE'
    if b[:8] != MAGIC2: return None, 'BAD_VERSION'
    if len(b) < IDS_AT + 4: return None, 'MALFORMED_MESSAGE'
    if b[68] not in FINAL or b[69] not in OUTCOME or b[70] not in STOP or b[71] & 0xF0: return None, 'MALFORMED_MESSAGE'
    ef = b[240]
    if ef & 0xE0: return None, 'MALFORMED_MESSAGE'
    capture_end, start_uptime = struct.unpack_from('<II', b, 241)
    if (not ef & 0x08 and capture_end != 0) or (not ef & 0x10 and start_uptime != 0): return None, 'MALFORMED_MESSAGE'
    n = b[IDS_AT]
    if not 1 <= n <= 32 or len(b) < IDS_AT + 2 + n: return None, 'MALFORMED_MESSAGE'
    m = b[IDS_AT + 1 + n]
    if not 1 <= m <= 32 or len(b) != IDS_AT + 2 + n + m: return None, 'MALFORMED_MESSAGE'
    vcu = b[IDS_AT + 1:IDS_AT + 1 + n].decode('latin1'); boot = b[IDS_AT + 2 + n:].decode('latin1')
    if not (IDENT.fullmatch(vcu) and IDENT.fullmatch(boot)): return None, 'MALFORMED_MESSAGE'
    sample_count, held, stored = struct.unpack_from('<III', b, 56)
    warnings, changes = struct.unpack_from('<II', b, 232)
    return {
        'key_id': b[8:16].hex(), 'test_id': uuid_str(b[16:32]), 'sample_count': sample_count, 'held_count': held,
        'stored_sample_count': stored, 'final_state': FINAL[b[68]], 'outcome': OUTCOME[b[69]], 'stop_reason': STOP[b[70]],
        'flags': b[71], 'run_digest': 'sha256:' + b[72:104].hex(), 'samples_digest': 'sha256:' + b[104:136].hex(),
        'event_digest': 'sha256:' + b[168:200].hex(), 'events_stored_digest': 'sha256:' + b[200:232].hex(),
        'warnings_count': warnings, 'command_changes_count': changes, 'event_flags': ef,
        'capture_end_ms': capture_end if ef & 0x08 else None, 'start_uptime_ms': start_uptime if ef & 0x10 else None,
        'vcu_id': vcu, 'origin_boot_id': boot,
    }, None


def decide_v2(signed, keyring, man):
    msg_b, sig = b64url_strict(signed['message']), b64url_strict(signed['signature'])
    if msg_b is None or sig is None or len(sig) != 64: return 'MALFORMED_ENCODING'
    m, why = parse_v2(msg_b)
    if m is None: return why
    key = next((k for k in keyring if k['key_id'] == m['key_id']), None)
    if key is None: return 'UNKNOWN_KEY'
    if not verify(b64url_strict(key['public_key']), msg_b, sig): return 'BAD_SIGNATURE'  # includes S >= L
    f, ef = m['flags'], m['event_flags']
    started = bool(f & 8)
    run_flags_bad = (bool(f & 1) != (m['samples_digest'] == m['run_digest'])
                     or bool(f & 2) != (m['stored_sample_count'] == m['held_count'])
                     or (f & 4 and m['held_count'] != m['sample_count']) or m['held_count'] > m['sample_count']
                     or m['stored_sample_count'] > m['held_count']
                     or (not started and (not f & 4 or m['sample_count'] != 0 or m['stop_reason'] != 'CONFIG_CANCELLED'
                                          or m['final_state'] != 'ABORTED' or m['outcome'] != 'INCOMPLETE'))
                     or (started and m['stop_reason'] == 'CONFIG_CANCELLED'))
    event_flags_bad = (bool(ef & 1) != (m['events_stored_digest'] == m['event_digest'])
                       or bool(ef & 0x10) != started or bool(ef & 0x08) != started)
    if run_flags_bad or event_flags_bad: return 'FLAGS_INCONSISTENT'
    verdict = m['outcome'] != 'INCOMPLETE'
    if m['stop_reason'] not in ALLOWED_STOP[m['final_state']] or (verdict and (m['final_state'] != 'COMPLETED' or f & 7 != 7)):
        return 'LIFECYCLE_INCONSISTENT'
    if m['test_id'] != man['test_id']: return 'TEST_ID_MISMATCH'
    if m['vcu_id'] != man['vcu_id']: return 'VCU_ID_MISMATCH'
    if m['origin_boot_id'] != man['origin_boot_id']: return 'BOOT_ID_MISMATCH'
    if (m['run_digest'] != man['run_digest'] or m['sample_count'] != man['sample_count']
            or m['held_count'] != man['held_count'] or started != man['started'] or bool(f & 4) != man['recording_complete']
            or m['final_state'] != man['final_state'] or m['stop_reason'] != man['stop_reason']
            or m['event_digest'] != man['event_digest'] or m['warnings_count'] != man['warnings_count']
            or m['command_changes_count'] != man['command_changes_count']
            or bool(ef & 2) != man['event_log_complete']
            or m['capture_end_ms'] != man['capture_end_ms'] or m['start_uptime_ms'] != man['start_uptime_ms']):
        return 'MANIFEST_MISMATCH'
    if m['stored_sample_count'] != m['held_count']: return 'SHORTFALL'
    if m['samples_digest'] != m['run_digest']: return 'DIGEST_MISMATCH'
    if not ef & 1: return 'EVENT_DIGEST_MISMATCH'
    return 'RELEASE'


def run_v1():
    print('--- MTRCPT1 (check_receipt_vectors.py)')
    try:
        v1.main()
    except SystemExit as e:
        return e.code or 0
    return 0


def main():
    v1_status = run_v1()
    print('--- MTRCPT2 (receipt-v2-vectors.json)')
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'vectors', 'receipt-v2-vectors.json')
    doc = json.load(open(path, encoding='utf-8'))
    seeds = {}
    for name, k in doc['test_keys'].items():
        seed = hashlib.sha256(k['seed_label'].encode()).digest()
        assert seed.hex() == k['seed_hex'], f'key {name}: seed'
        pub = public_from_seed(seed)
        assert pub.hex() == k['public_key_hex'], f'key {name}: public key'
        assert hashlib.sha256(pub).digest()[:8].hex() == k['key_id'], f'key {name}: key_id'
        seeds[k['key_id']] = seed
    fails = resigned = 0
    for v in doc['vectors']:
        reason = v['expected']['reason']
        got = decide_v2(v['signed_receipt'], doc['vcu_keyring'], v['vcu_manifest'])
        ok = got == reason and (got == 'RELEASE') == v['expected']['release']
        msg = bytes.fromhex(v['message_hex'])
        # Re-sign untampered messages (everything except tampered encoding / signature / message bytes).
        if reason not in ('MALFORMED_ENCODING', 'BAD_SIGNATURE'):
            ok = ok and b64url_strict(v['signed_receipt']['message']) == msg
            ok = ok and b64url_strict(v['signed_receipt']['signature']) == sign(seeds[msg[8:16].hex()], msg)
            resigned += 1
        # The parsed fields must equal the generator's decoded_message for every well-formed MTRCPT2 message.
        parsed, _ = parse_v2(msg)
        if v['decoded_message'] is not None or parsed is not None:
            dm = v['decoded_message'] or {}
            ok = ok and parsed is not None and all(parsed[k] == dm.get(k) for k in parsed)
        fails += not ok
        print(('PASS' if ok else 'FAIL'), v['id'], got)
    n = len(doc['vectors'])
    print(f'{n - fails}/{n} MTRCPT2 vectors agree ({resigned} re-signed byte for byte)')
    if v1_status: print('MTRCPT1 check FAILED')
    sys.exit(1 if fails or v1_status else 0)


if __name__ == '__main__':
    main()
