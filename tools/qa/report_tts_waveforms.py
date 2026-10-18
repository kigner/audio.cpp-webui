"""Read successful saved TTS WAVs and flag listening clues, never acoustic FAILs."""
import argparse
import hashlib
import json
import struct
from datetime import datetime, timezone
from pathlib import Path

import numpy as np


def runs(mask):
    edges = np.diff(np.r_[False, mask, False].astype(np.int8))
    return list(zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)))


def read_wav(path):
    raw = path.read_bytes()
    if len(raw) < 12 or raw[:4] != b'RIFF' or raw[8:12] != b'WAVE':
        raise ValueError('Not a RIFF WAV')
    pos, fmt, payload = 12, None, None
    while pos + 8 <= len(raw):
        kind, size = raw[pos:pos + 4], struct.unpack_from('<I', raw, pos + 4)[0]
        pos += 8
        if pos + size > len(raw):
            raise ValueError('Truncated WAV chunk')
        if kind == b'fmt ':
            fmt = raw[pos:pos + size]
        elif kind == b'data':
            payload = raw[pos:pos + size]
        pos += size + (size & 1)
    if fmt is None or payload is None or len(fmt) < 16:
        raise ValueError('WAV missing fmt/data')
    code, channels, rate, _, align, bits = struct.unpack_from('<HHIIHH', fmt)
    if code == 0xFFFE and len(fmt) >= 40:
        code = struct.unpack_from('<H', fmt, 24)[0]
    if channels <= 0 or rate <= 0 or bits not in (8, 16, 24, 32, 64) or align != channels * (bits // 8) or len(payload) % align:
        raise ValueError('Invalid WAV sample format')
    if code == 3 and bits in (32, 64):
        data = np.frombuffer(payload, dtype='<f4' if bits == 32 else '<f8').astype(np.float64)
        subtype = 'FLOAT' if bits == 32 else 'DOUBLE'
    elif code == 1:
        if bits == 8:
            data = np.frombuffer(payload, dtype=np.uint8).astype(np.float64) - 128
        elif bits == 24:
            octets = np.frombuffer(payload, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
            data = octets[:, 0] | (octets[:, 1] << 8) | (octets[:, 2] << 16)
            data = np.where(data & 0x800000, data - 0x1000000, data).astype(np.float64)
        else:
            data = np.frombuffer(payload, dtype={16: '<i2', 32: '<i4', 64: '<i8'}[bits]).astype(np.float64)
        data /= 2 ** (bits - 1)
        subtype = 'PCM_U8' if bits == 8 else 'PCM_' + str(bits)
    else:
        raise ValueError('Unsupported WAV encoding')
    return data.reshape(-1, channels), rate, subtype


def inspect(path):
    data, rate, subtype = read_wav(path)
    if not data.size or not np.isfinite(data).all():
        raise ValueError('Empty or nonfinite samples')
    magnitude = np.abs(data)
    bits = {'PCM_U8': 8, 'PCM_16': 16, 'PCM_24': 24, 'PCM_32': 32, 'PCM_64': 64}.get(subtype)
    limit = 1 - 2 ** (1 - bits) if bits else 1.0
    full = magnitude >= limit
    full_runs = runs(np.any(full, axis=1))
    block = max(1, round(rate * .02))
    starts = np.arange(0, len(data), block)
    lengths = np.minimum(block, len(data) - starts)
    frame_squares = np.mean(data * data, axis=1)
    rms = np.sqrt(np.add.reduceat(frame_squares, starts) / lengths)
    quiet_runs = [(int(starts[a]), int(starts[b - 1] + lengths[b - 1]))
                  for a, b in runs(rms < .0001)]
    long_quiet = [(a, b) for a, b in quiet_runs if b - a >= rate * .5]
    row = {
        'sample_rate': rate, 'channels': data.shape[1], 'frames': len(data),
        'duration_seconds': len(data) / rate, 'subtype': subtype,
        'peak': float(magnitude.max()), 'rms': float(np.sqrt(np.mean(data * data))),
        'full_scale_threshold': limit, 'full_scale_sample_ratio': float(full.mean()),
        'near_full_scale_0_999_ratio': float((magnitude >= .999).mean()),
        'maximum_full_scale_run_seconds': max((b - a) / rate for a, b in full_runs) if full_runs else 0.0,
        'digital_zero_sample_ratio': float((data == 0).mean()),
        'long_quiet_frame_ratio': sum(b - a for a, b in long_quiet) / len(data),
        'maximum_quiet_seconds': max((b - a) / rate for a, b in quiet_runs) if quiet_runs else 0.0,
        'long_quiet_spans_seconds': [[a / rate, b / rate] for a, b in long_quiet],
    }
    clues = []
    if row['full_scale_sample_ratio'] >= .001 or row['maximum_full_scale_run_seconds'] >= .002:
        clues.append('满幅样本较多或连续满幅，试听核对；不据峰值直接判失真')
    if row['long_quiet_frame_ratio'] >= .35 or row['maximum_quiet_seconds'] >= 2:
        clues.append('较长低能量区，试听核对停顿/尾静音/文本完整性')
    row.update(listening_clues=clues, quality_status='需试听线索' if clues else '仍需试听')
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path('build/functional-qa-20261008'))
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    output = args.output or args.source / 'tts-waveform-screening.json'
    if any(output.resolve().is_relative_to((args.source / folder).resolve())
           for folder in ('cases', 'artifacts', 'logs', 'live-execution')):
        parser.error('Report must not overwrite original records/artifacts/logs')
    rows = []
    for record_path in sorted((args.source / 'cases').glob('*.json')):
        record = json.loads(record_path.read_text(encoding='utf-8'))
        case = record.get('case') or {}
        if case.get('task') != 'tts' or record.get('verdict') != 'PASS' or case.get('expect', 'done') != 'done':
            continue
        for artifact in record.get('artifacts') or []:
            path = Path(artifact.get('path') or '')
            if path.suffix.lower() != '.wav':
                continue
            row = {'case_id': case.get('id', record_path.stem), 'model': case.get('model'),
                   'surface': record.get('surface', case.get('surface', 'workbench_http')),
                   'record': str(record_path.resolve()), 'path': str(path.resolve()),
                   'context_sha256': record.get('context_sha256'), 'quality_status': '需复核文件'}
            try:
                row['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
                row['record_hash_matches'] = row['sha256'] == artifact.get('sha256')
                row.update(inspect(path))
                if not row['record_hash_matches']:
                    row['quality_status'] = '需复核文件哈希'
            except (OSError, ValueError, RuntimeError) as error:
                row['error'] = str(error)
            rows.append(row)
    report = {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'scope': 'Top-level PASS successful TTS WAVs; excludes attempts/negative/cancelled. CLI raw is separately labeled, not UI evidence.',
        'method': 'Decode existing WAV; count full-scale/near-full-scale samples. 20ms RMS windows below 1e-4 (-80dBFS), contiguous spans >=0.5s count as long quiet.',
        'limits': 'Peak 1, digital silence or full-scale samples alone do not prove audible clipping, distortion or failure. Intentional pauses, padding and quiet phonemes can explain silence. This report changes no functional verdict and grants no quality acceptance.',
        'audio_count': len(rows), 'listening_clue_count': sum(bool(r.get('listening_clues')) for r in rows),
        'rows': rows,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    lines = ['# TTS波形粗筛', '', report['limits'], '', report['method'], '',
             '| Case | Surface | 满幅样本 | 长低能量比例 | 最长低能量秒 | 听审线索 |',
             '|---|---|---:|---:|---:|---|']
    for row in rows:
        lines.append('| ' + row['case_id'] + ' | ' + row['surface'] + ' | '
                     + f"{row.get('full_scale_sample_ratio', 0):.3%}" + ' | '
                     + f"{row.get('long_quiet_frame_ratio', 0):.3%}" + ' | '
                     + f"{row.get('maximum_quiet_seconds', 0):.3f}" + ' | '
                     + ('；'.join(row.get('listening_clues', [])) or row['quality_status']) + ' |')
    output.with_suffix('.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({'report': str(output.resolve()), 'audios': len(rows),
                      'listening_clues': report['listening_clue_count']}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
