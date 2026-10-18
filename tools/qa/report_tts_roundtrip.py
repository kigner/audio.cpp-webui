"""Compare saved TTS roundtrip ASR text; low similarity requests listening review.

This offline report never runs inference and never changes functional verdicts.
"""
import argparse
import difflib
import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path


def normalized_chars(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', text).casefold()
                   if unicodedata.category(c)[0] in {'L', 'N'})


def english_words(text):
    normalized = unicodedata.normalize('NFKC', text).casefold().replace('\u2019', "'")
    return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)*", normalized)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=Path('build/functional-qa-20261008/tts-roundtrip-cases.json'))
    parser.add_argument('--records', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--review-threshold', type=float, default=0.75)
    args = parser.parse_args()
    if not 0 <= args.review_threshold <= 1:
        parser.error('--review-threshold must be between 0 and 1')
    records = args.records or args.manifest.parent / 'cases'
    output = args.output or args.manifest.parent / 'tts-roundtrip-quality.json'
    manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
    rows = []
    for case in manifest['cases']:
        source = case['quality_source']
        row = {'model': source['model'], 'source_case': source['case_id'], 'asr_case': case['id'],
               'source_surface': source.get('surface', 'workbench_http'),
               'expected_text': source['expected_text'], 'audio_sha256': source['audio_sha256'],
               'status': '待ASR', 'functional_verdict': None, 'char_similarity': None,
               'english_word_similarity': None}
        path = records / (case['id'] + '.json')
        if not path.is_file():
            rows.append(row)
            continue
        record = json.loads(path.read_text(encoding='utf-8'))
        if record.get('surface') == 'cli_raw' or record.get('case', {}).get('surface') == 'cli_raw':
            row.update(status='需复核（ASR 记录来自 CLI raw）', asr_surface='cli_raw',
                       functional_verdict=record.get('verdict'), record=str(path.resolve()))
            rows.append(row)
            continue
        row.update(record=str(path.resolve()), functional_verdict=record.get('verdict'),
                   transcript=record.get('job', {}).get('text', ''), error=record.get('error'))
        # A manifest may be regenerated while earlier roundtrip records still exist.
        actual_source = record.get('case', {}).get('quality_source', {})
        if actual_source.get('audio_sha256') != source['audio_sha256']:
            row['status'] = '待重跑ASR（音频已变化）'
            rows.append(row)
            continue
        expected = normalized_chars(row['expected_text'])
        actual = normalized_chars(row['transcript'])
        row['normalized_expected'] = expected
        row['normalized_transcript'] = actual
        row['char_similarity'] = round(difflib.SequenceMatcher(None, expected, actual, autojunk=False).ratio(), 4)
        expected_words = english_words(row['expected_text'])
        if expected_words:
            row['english_word_similarity'] = round(difflib.SequenceMatcher(
                None, expected_words, english_words(row['transcript']), autojunk=False).ratio(), 4)
        low = row['char_similarity'] < args.review_threshold or (
            row['english_word_similarity'] is not None and row['english_word_similarity'] < args.review_threshold)
        row['status'] = '需听审' if record.get('verdict') != 'PASS' or not actual or low else '待听审（文字相似度较高）'
        rows.append(row)
    report = {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'manifest': str(args.manifest.resolve()), 'review_threshold': args.review_threshold,
        'method': 'NFKC + casefold; Unicode letters/numbers for character sequence similarity; '
                  'English word tokens compared separately using SequenceMatcher. Punctuation/spacing are ignored.',
        'limits': 'ASR can itself misrecognize. Low similarity only flags listening review, never an acoustic FAIL. '
                  'High similarity does not prove naturalness, voice similarity, emotion, clipping absence or overall quality.',
        'pending_models_without_successful_offline_audio': manifest.get('pending_models_without_successful_offline_audio', []),
        'models': rows,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    lines = ['# TTS 往返文字筛查', '', '相似度只筛选需听审结果，不替代听感，不改变功能PASS/FAIL。', '',
             '| TTS模型 | 字符相似度 | 英文词相似度 | 状态 |', '|---|---:|---:|---|']
    for row in rows:
        char = '-' if row['char_similarity'] is None else f"{row['char_similarity']:.1%}"
        word = '-' if row['english_word_similarity'] is None else f"{row['english_word_similarity']:.1%}"
        lines.append(f"| {row['model']} | {char} | {word} | {row['status']} |")
    output.with_suffix('.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({'report': str(output.resolve()), 'models': len(rows),
                      'needs_listening_review': sum(r['status'] == '需听审' for r in rows)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
