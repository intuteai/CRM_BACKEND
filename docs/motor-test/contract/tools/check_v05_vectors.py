"""Independent re-computation of the v0.5 event digests (MTEVT2) in vectors/v05-event-vectors.json
(standard library only, no code shared with tools/v05.js). Byte layout: docs/motor-test/contract/v05-warning-events.md
section 6.

    python docs/motor-test/contract/tools/check_v05_vectors.py
"""
import hashlib, json, os, struct, sys

PHASE = {'PRE_START': 1, 'CAPTURE': 2, 'POST_CAPTURE': 3}
KIND = {'ACTIVE_AT_START': 1, 'RAISED': 2, 'CLEARED': 3, 'STATUS_UNKNOWN': 4, 'STATUS_KNOWN': 5,
        'DETAIL': 6, 'DETAIL_UNAVAILABLE': 7, 'DETAIL_AMBIGUOUS': 8}
SOURCE = {'STATUS_BIT6': 1, 'VCU_LIMIT': 2, 'SDO_2031_11': 3}
REASON = {None: 0, 'TIMEOUT': 1, 'ABORT': 2, 'MALFORMED': 3, 'LATE_REPLY': 4}
RESTORED = {None: 0, 'ACTIVE': 1, 'CLEAR': 2}
LINK = {'OWNS_READING': 1, 'SUPERSEDED': 2, 'NO_READING': 3, 'READING_NOT_RETAINED': 4}

def opt_u32(v):
    return struct.pack('<BI', 0, 0) if v is None else struct.pack('<BI', 1, v)

def digest(ev, run):
    b = bytearray(b'MTEVT2\x00\x00')
    b += struct.pack('<B', 1 if run['started'] else 0)
    b += opt_u32(ev['capture_end_ms'])
    b += opt_u32(run.get('start_uptime_ms'))
    b += struct.pack('<I', len(ev['warnings']))
    for w in ev['warnings']:
        lim = (w['limit_id'] or '').encode('latin1')
        mask = (1 if w['code'] is not None else 0) | (2 if w['status_t_ms'] is not None else 0) | (4 if w['limit_id'] is not None else 0)
        b += struct.pack('<IiBBBBBBHiB', w['seq'], w['t_ms'], PHASE[w['phase']], KIND[w['kind']], SOURCE[w['source']],
                         REASON[w['reason']], RESTORED[w['restored_state']], mask, w['code'] or 0, w['status_t_ms'] or 0, len(lim)) + lim
    b += struct.pack('<I', len(ev['command_changes']))
    for c in ev['command_changes']:
        has = c['first_sample_seq'] is not None
        b += struct.pack('<IiiBBI', c['step'], c['t_ms'], c['rpm_cmd'], LINK[c['link']], 1 if has else 0, c['first_sample_seq'] if has else 0)
    log = ev['event_log']
    b += struct.pack('<B', 1 if log['complete'] else 0) + opt_u32(log['lost_count'])
    return 'sha256:' + hashlib.sha256(bytes(b)).hexdigest()

def main():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'vectors', 'v05-event-vectors.json')
    doc = json.load(open(path, encoding='utf-8'))
    fails = 0; checked = 0
    for case in doc['cases']:
        if case['expected']['result'] != 'accepted':
            continue
        got = digest(case['v05_fields'], case['run_context'])
        match = got == case['v05_fields']['event_digest']
        ok = got == case['expected']['recomputed_event_digest'] and match == case['expected']['flags']['event_digest_match']
        checked += 1; fails += not ok
        print(('PASS' if ok else 'FAIL'), case['id'], got[:23] + '...', 'uploaded digest matches' if match else 'uploaded digest differs')
    print(f'{checked - fails}/{checked} accepted-case digests agree')
    sys.exit(1 if fails else 0)

if __name__ == '__main__':
    main()
