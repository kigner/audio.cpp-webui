"""Prepare one offline Qwen3-ASR case per successful current TTS model.

Reads saved evidence only; never contacts the WebUI, loads models or starts jobs.
Run again after more TTS records arrive to refresh the manifest.
"""
import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path('build/functional-qa-20261008'))
    parser.add_argument('--output', type=Path)
    parser.add_argument('--asr-model', default='qwen3-asr')
    args = parser.parse_args()
    output = args.output or args.source / 'tts-roundtrip-cases.json'
    candidates, pending, excluded_raw = {}, set(), []
    for path in sorted((args.source / 'cases').glob('*.json')):
        record = json.loads(path.read_text(encoding='utf-8'))
        case = record.get('case', {})
        if record.get('surface') == 'cli_raw' or case.get('surface') == 'cli_raw':
            excluded_raw.append({'case_id': case.get('id', path.stem), 'record': str(path.resolve())})
            continue
        if case.get('task') != 'tts' or case.get('expect', 'done') != 'done':
            continue
        model = case['model']
        pending.add(model)
        if record.get('verdict') != 'PASS' or case.get('inputs', {}).get('stream'):
            continue
        text = case.get('inputs', {}).get('text', '').strip()
        audio = next((a for a in record.get('artifacts', [])
                      if a.get('sample_rate', 0) > 0 and a.get('duration', 0) > 0
                      and Path(a.get('path', '')).is_file()), None)
        if not text or audio is None:
            continue
        candidate = (case, record, path, audio, text)
        # Prefer the most recently completed successful offline generation.
        if model not in candidates or record.get('started_at', '') > candidates[model][1].get('started_at', ''):
            candidates[model] = candidate
    cases = []
    for model, (source, record, path, audio, text) in sorted(candidates.items()):
        cases.append({
            'id': 'roundtrip-tts-' + re.sub(r'[^A-Za-z0-9_.-]', '-', model),
            'task': 'asr', 'model': args.asr_model,
            'inputs': {'stream': False, 'detailed': False, 'dialogue': False, 'context': ''},
            'uploads': {'audio': str(Path(audio['path']).resolve())},
            'options': {'max_tokens': 128, 'audio_chunk_mode': 'none'},
            'expect': 'done', 'timeout': 900,
            'coverage': ['tts-roundtrip-text-screening', 'offline-asr'],
            'quality_source': {
                'model': model, 'case_id': source['id'], 'expected_text': text,
                'case_record': str(path.resolve()), 'started_at': record.get('started_at'),
                'audio_sha256': audio['sha256'], 'audio_path': str(Path(audio['path']).resolve()),
                'context_path': record.get('context_path'), 'context_sha256': record.get('context_sha256'),
                'surface': record.get('surface', 'workbench_http'),
            },
        })
    manifest = {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'source': str(args.source.resolve()),
        'note': 'Only current top-level PASS offline TTS evidence is selected; no attempts directory is read. '
                'ASR agreement is a text screening signal and does not replace listening or prove acoustic quality.',
        'pending_models_without_successful_offline_audio': sorted(pending - candidates.keys()),
        'excluded_cli_raw_records': excluded_raw,
        'cases': cases,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'manifest': str(output.resolve()), 'models': len(cases),
                      'pending': manifest['pending_models_without_successful_offline_audio']}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
