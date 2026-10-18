"""Read-only local proof for browser cases that require freshly downloaded weights.

The browser supplies the immediately verified UI identity. The shared API guard
then checks the actual native process and model. This module makes no HTTP calls,
does not load a model, and never starts audiocpp_cli.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_workbench_functional import fresh_native_model_evidence


def verify(case, context, observed, context_path, context_sha256, base,
           checker=fresh_native_model_evidence):
    url = urlsplit(base)
    if (url.scheme != 'http' or url.hostname not in {'127.0.0.1', 'localhost'} or
            url.username or url.password or url.query or url.fragment or url.path not in {'', '/'}):
        raise AssertionError('Fresh browser proof requires a local HTTP root workbench URL')
    if not case.get('required_native_model_path') or not case.get('fresh_download_required'):
        raise AssertionError('Fresh browser proof requires an explicit fresh-download case')
    expected_health = context.get('health', {})
    observed_health = observed.get('health', {})
    for key in ('instance_id', 'runtime_revision', 'pid'):
        if not expected_health.get(key) or observed_health.get(key) != expected_health[key]:
            raise AssertionError('Browser runtime identity changed: ' + key)
    if (Path(observed.get('path', '')).resolve() != Path(context_path).resolve() or
            observed.get('sha256') != context_sha256):
        raise AssertionError('Browser runtime context does not match the frozen request context')
    executable = Path(context['server_exe']).resolve()
    if (Path(observed.get('server_exe', '')).resolve() != executable or
            observed.get('server_sha256') != context.get('server_sha256')):
        raise AssertionError('Browser server binary identity differs from the request context')
    with executable.open('rb') as stream:
        executable_sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    if executable_sha != context.get('server_sha256'):
        raise AssertionError('Browser server binary SHA changed')
    proof = checker(case, context)
    if not proof:
        raise AssertionError('Shared native model guard returned no evidence')
    return {**proof, 'browser_runtime_context': {
        'path': str(Path(context_path).resolve()), 'sha256': context_sha256,
        'health': {key: observed_health[key] for key in ('instance_id', 'runtime_revision', 'pid')},
        'server_exe': str(executable), 'server_sha256': executable_sha,
    }}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case-file', type=Path, required=True)
    parser.add_argument('--context', type=Path, required=True)
    parser.add_argument('--runtime-proof', type=Path, required=True)
    parser.add_argument('--base', required=True)
    args = parser.parse_args()
    if Path.cwd().resolve() != ROOT:
        raise AssertionError('Fresh model guard must run from this repository root')
    context_bytes = args.context.read_bytes()
    result = verify(
        json.loads(args.case_file.read_text(encoding='utf-8-sig')),
        json.loads(context_bytes.decode('utf-8-sig')),
        json.loads(args.runtime_proof.read_text(encoding='utf-8-sig')),
        args.context, hashlib.sha256(context_bytes).hexdigest(), args.base)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
