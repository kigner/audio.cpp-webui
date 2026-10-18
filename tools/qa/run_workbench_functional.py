"""Replay serial, real-model Workbench cases; save requests, stages and artifacts.

Uses existing model paths. Does not install models or alter the model catalog.
Example: python tools/qa/run_workbench_functional.py --manifest build/functional-qa-20261008/cases.json --task tts
"""
import argparse
import hashlib
import io
import json
import shutil
import subprocess
import time
import wave
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests


def update_summary(output):
    records = []
    for path in sorted((output / 'cases').glob('*.json')):
        try:
            record = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(record, dict):
                raise ValueError('case record must be an object')
        except (OSError, ValueError) as error:
            record = {'case': {'id': path.stem}, 'verdict': 'NEED_REVIEW', 'elapsed': '-',
                      'artifacts': [], 'error': f'Saved evidence unreadable: {error}'}
        records.append(record)
    lines = ['# 真实模型测试进度', '', '每完成一个用例立即更新。PASS 代表该用例的自动检查通过，音质由试听确认。', '',
             '| 用例 | 结果 | 秒 | 产物 |', '|---|---|---:|---|']
    for record in records:
        case = (record.get('case') or {}).get('id', 'unknown-case')
        artifact_links = []
        for artifact in record.get('artifacts') or []:
            if not isinstance(artifact, dict):
                continue
            path = Path(artifact.get('path') or output / 'artifacts' / case / artifact.get('name', 'artifact'))
            try:
                target = path.resolve().relative_to(output.resolve()).as_posix()
            except ValueError:
                target = path.resolve().as_posix()
            artifact_links.append(f"[{artifact.get('name') or path.name}](<{target}>)")
        links = ', '.join(artifact_links)
        reason = str(record.get('skip_reason') or record.get('error', '')).replace('|', '/').replace('\n', ' ')
        surface = ' · CLI raw' if record.get('surface') == 'cli_raw' else ''
        lines.append(f"| [{case}](cases/{case}.json) | {record.get('verdict', 'PENDING')}{surface} | {record.get('elapsed', '-')} | {links or reason} |")
    (output / 'progress.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def dependency_preflight(case, output):
    """No API calls: do not retry a model load already rejected by its probe."""
    dependencies = case.get('depends_on', [])
    for ident in [dependencies] if isinstance(dependencies, str) else dependencies:
        path = output / 'cases' / (ident + '.json')
        if not path.is_file():
            return {'verdict': 'PENDING', 'pending_category': 'DEPENDENCY_PENDING', 'dependency': ident,
                    'skip_reason': f'Prerequisite case {ident} has no saved result; run it first.'}
        try:
            record = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(record, dict):
                raise ValueError('dependency result must be an object')
        except (OSError, ValueError) as error:
            return {'verdict': 'PENDING', 'pending_category': 'DEPENDENCY_EVIDENCE', 'dependency': ident,
                    'skip_reason': f'Prerequisite result {ident} is not readable yet: {error}'}
        if record.get('verdict') != 'PASS':
            reason = record.get('skip_reason') or record.get('error') or (record.get('job') or {}).get('message') or record.get('verdict')
            return {'verdict': 'BLOCKED', 'failure_category': 'DEPENDENCY_BLOCKED', 'dependency': ident,
                    'dependency_failure_category': record.get('failure_category') or record.get('block_category'),
                    'skip_reason': f'Prerequisite {ident} did not pass: {reason}'}
    for field, filename in case.get('uploads', {}).items():
        if not Path(filename).is_file():
            return {'verdict': 'BLOCKED', 'failure_category': 'INPUT_PREREQUISITE',
                    'skip_reason': f'Missing {field} fixture: {filename}'}
    return None


def model_preflight(case, detail, catalog=None):
    """Use current API readiness rather than guessing from a planned download path."""
    if detail.get('incomplete'):
        return {'verdict': 'BLOCKED', 'failure_category': 'MODEL_INCOMPLETE',
                'skip_reason': f"Model {case['model']} is incomplete: {detail.get('missing') or detail.get('missing_files') or 'required files missing'}"}
    if not detail.get('installed'):
        package = (case.get('requires') or {}).get('package_id')
        return {'verdict': 'BLOCKED', 'failure_category': 'DOWNLOAD_PREREQUISITE' if package else 'MODEL_NOT_INSTALLED',
                'skip_reason': f"Model {case['model']} is not installed/ready" + (f'; package {package}' if package else '')}
    require_diar = bool(case.get('inputs', {}).get('dialogue')) or 'diar' in case.get('prerequisites', {}).get('installed_model_task_any', [])
    if require_diar and catalog is not None:
        available = [m for m in catalog.get('models', []) if m.get('model_task') == 'diar' and m.get('installed') and not m.get('incomplete')]
        if not available:
            return {'verdict': 'BLOCKED', 'failure_category': 'DIAR_MODEL_PREREQUISITE',
                    'skip_reason': 'Dialogue mode requires an installed complete diarization model.'}
    return None


def record_asr_text(result, job, elapsed):
    changes = result.setdefault('text_changes', [])
    text = job.get('text', '')
    terminal = job['status'] in {'done', 'error', 'cancelled'}
    if not changes or changes[-1]['text'] != text or terminal and not changes[-1]['final']:
        changes.append({'elapsed': round(elapsed, 3), 'status': job['status'], 'text': text, 'final': terminal})


def fresh_native_model_evidence(case, context):
    """A fresh-download case must actually use its verified local file."""
    required = case.get('required_native_model_path')
    if not required:
        return None
    if not context or not case.get('fresh_download_required'):
        raise AssertionError('Fresh native model proof requires runtime context and download gate')
    with open(context['server_exe'], 'rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != context['server_sha256']:
            raise AssertionError('Native server binary changed from reviewed runtime context')
    proof_path = Path('build/functional-fixes-20261009/new-rvc/fresh-download-verified.json')
    proof = json.loads(proof_path.read_text(encoding='utf-8'))
    weight = Path(proof['path']).resolve()
    if not proof.get('fresh_network_download') or not weight.is_relative_to(Path(required).resolve()):
        raise AssertionError('Fresh download evidence does not identify the required model directory')
    with weight.open('rb') as stream:
        sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    if sha != proof['sha256'] or sha != proof['remote_lfs_sha256']:
        raise AssertionError('Fresh model no longer matches upstream file fingerprint')
    captured = subprocess.run([
        'rtk', 'proxy', 'powershell', '-NoProfile', '-File',
        str(Path(__file__).with_name('capture_native_runtime.ps1').resolve()),
        '-ExpectedExe', context['server_exe']], capture_output=True, check=True,
        encoding='utf-8-sig', timeout=20)
    processes = json.loads(captured.stdout)
    matches = [process for process in processes if process['port'] == 8088
               and process['parent_pid'] == context['health']['pid']
               and process['pid'] in process.get('listener_owners', [])
               and any(model.get('id') == case['model'] and Path(model['path']).resolve() == weight
                       for model in process.get('models', []))]
    if len(matches) != 1:
        raise AssertionError('Native RVC configuration did not load the verified fresh D-drive file')
    return {'fresh_download_evidence': str(proof_path.resolve()), 'sha256': sha,
            'weight_path': str(weight), 'native_process': matches[0]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--context', type=Path, help='Runtime evidence JSON copied into every case record.')
    parser.add_argument('--base', default='http://127.0.0.1:7860')
    parser.add_argument('--task')
    parser.add_argument('--case', action='append', default=[])
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--record-asr-text', action='store_true', help='Save sampled ASR text changes and the terminal snapshot.')
    parser.add_argument('--poll-interval', type=float, default=.5, help='Job polling interval in seconds; default .5.')
    args = parser.parse_args()
    if not np.isfinite(args.poll_interval) or args.poll_interval <= 0:
        parser.error('--poll-interval must be a finite positive number')
    args.output = args.output or args.manifest.resolve().parent
    args.output.mkdir(parents=True, exist_ok=True)
    context = None
    if args.context:
        context_blob = args.context.read_bytes()
        context = json.loads(context_blob.decode('utf-8-sig'))
    session = requests.Session()
    session.trust_env = False
    api = args.base.rstrip('/') + '/api/workbench'

    def request(method, route, **kwargs):
        response = session.request(method, api + route, timeout=kwargs.pop('timeout', 330), **kwargs)
        response.raise_for_status()
        return response.json()

    cases = json.loads(args.manifest.read_text(encoding='utf-8'))['cases']
    complete = set()
    if args.resume:
        for path in (args.output / 'cases').glob('*.json'):
            try:
                saved = json.loads(path.read_text(encoding='utf-8'))
                if isinstance(saved, dict) and saved.get('verdict') == 'PASS':
                    complete.add(path.stem)
            except (OSError, ValueError):
                pass
    uploads = {}
    for case in cases:
        ident = case['id']
        if ident in complete or args.task and case['task'] != args.task or args.case and ident not in args.case:
            continue
        start = time.monotonic()
        result = {'surface': 'workbench_http', 'case': case, 'started_at': datetime.now(timezone.utc).isoformat(),
                  'stages': [], 'artifacts': [], 'verdict': 'FAIL'}
        if args.context:
            result.update(context=context, context_path=str(args.context.resolve()),
                          context_sha256=hashlib.sha256(context_blob).hexdigest())
        job_id = None
        print('START ' + ident, flush=True)
        try:
            if case.get('skip_reason'):
                result.update(verdict='BLOCKED', skip_reason=case['skip_reason'])
                print('  BLOCKED ' + str(case['skip_reason']), flush=True)
                continue
            prerequisite = dependency_preflight(case, args.output)
            if prerequisite is not None:
                result.update(prerequisite)
                result['stages'].append({'elapsed': round(time.monotonic() - start, 2),
                                         'status': result['verdict'].lower(), 'message': result['skip_reason']})
                print('  ' + result['verdict'] + ' ' + result['skip_reason'], flush=True)
                continue
            result['detail'] = request('GET', '/models/' + case['model'])
            prerequisite = model_preflight(case, result['detail'])
            require_diar = bool(case.get('inputs', {}).get('dialogue')) or 'diar' in case.get('prerequisites', {}).get('installed_model_task_any', [])
            if prerequisite is None and require_diar:
                catalog = request('GET', '/catalog', timeout=30)
                result['diar_prerequisites'] = [m for m in catalog.get('models', []) if m.get('model_task') == 'diar']
                prerequisite = model_preflight(case, result['detail'], catalog)
            if prerequisite is not None:
                result.update(prerequisite)
                result['stages'].append({'elapsed': round(time.monotonic() - start, 2),
                                         'status': 'blocked', 'message': result['skip_reason']})
                print('  BLOCKED ' + result['skip_reason'], flush=True)
                continue
            state = request('GET', '/status', timeout=10)
            if state['busy'] or state['realtime_active']:
                raise RuntimeError('Workspace is occupied; refusing to interfere with another task.')
            inputs = dict(case.get('inputs', {}))
            for key, filename in case.get('uploads', {}).items():
                if filename not in uploads:
                    with open(filename, 'rb') as stream:
                        uploads[filename] = request('POST', '/uploads', files={'file': (Path(filename).name, stream)})['id']
                inputs[key] = uploads[filename]
            if case.get('required_native_model_path'):
                request('POST', '/models/' + case['model'] + '/load', json={'options': case.get('options', {})})
                result['fresh_native_model_before_inference'] = fresh_native_model_evidence(case, context)
            payload = {k: case[k] for k in ('task', 'model')}
            payload.update(inputs=inputs, options=case.get('options', {}), action=case.get('action', 'generate'))
            result['request'] = payload
            submitted = request('POST', '/jobs', json=payload)
            job_id = submitted['id']
            result['job_id'] = job_id
            last = None
            segment_count = segment_bytes = 0
            sample_rates = set()
            while True:
                job = request('GET', f'/jobs/{job_id}?after={segment_count - 1}', timeout=15)
                if args.record_asr_text and case['task'] == 'asr':
                    record_asr_text(result, job, time.monotonic() - start)
                for segment in job.get('audio_segments', []):
                    if segment['index'] > segment_count:
                        import base64
                        segment_bytes += len(base64.b64decode(segment['pcm']))
                        sample_rates.add(segment['sample_rate'])
                        segment_count = segment['index']
                signature = (job['status'], job.get('message'))
                if signature != last:
                    result['stages'].append({'elapsed': round(time.monotonic() - start, 2),
                                             'status': signature[0], 'message': signature[1]})
                    print(f'  {ident} {signature[0]} {signature[1]}', flush=True)
                    last = signature
                if job['status'] in {'done', 'error', 'cancelled'}:
                    break
                elapsed = time.monotonic() - start
                if case.get('cancel_after') and elapsed >= case['cancel_after'] and not result.get('cancel_response'):
                    result['cancel_response'] = request('POST', f'/jobs/{job_id}/cancel', json={})
                if elapsed > case.get('timeout', 900):
                    request('POST', f'/jobs/{job_id}/cancel', json={})
                    result['timeout'] = True
                    # Settle cancellation before permitting a subsequent model.
                    for _ in range(30):
                        job = request('GET', f'/jobs/{job_id}', timeout=15)
                        if job['status'] in {'done', 'error', 'cancelled'}:
                            break
                        time.sleep(1)
                    else:
                        raise RuntimeError('Timed out; cancellation did not settle. Stop the run.')
                    break
                time.sleep(args.poll_interval)
            if args.record_asr_text and case['task'] == 'asr':
                record_asr_text(result, job, time.monotonic() - start)
            result['job'] = {k: v for k, v in job.items() if k != 'audio_segments'}
            if job['status'] == 'done' and case.get('required_native_model_path'):
                result['fresh_native_model'] = fresh_native_model_evidence(case, context)
                before = result['fresh_native_model_before_inference']['native_process']
                after = result['fresh_native_model']['native_process']
                if any(before[key] != after[key] for key in ('pid', 'created')):
                    raise AssertionError('Native process changed during fresh-model inference')
            result['stream'] = {'segments': segment_count, 'pcm_bytes': segment_bytes, 'sample_rates': sorted(sample_rates)}
            for artifact in job.get('artifacts', []):
                response = session.get(args.base + artifact['url'], timeout=30)
                response.raise_for_status()
                blob = response.content
                destination = args.output / 'artifacts' / ident / artifact['name']
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(blob)
                evidence = {'name': artifact['name'], 'path': str(destination.resolve()),
                            'bytes': len(blob), 'sha256': hashlib.sha256(blob).hexdigest()}
                if artifact['kind'] == 'audio':
                    with wave.open(io.BytesIO(blob), 'rb') as wav:
                        rate, channels, width = wav.getframerate(), wav.getnchannels(), wav.getsampwidth()
                        raw = wav.readframes(wav.getnframes())
                    if width not in (1, 2, 4):
                        raise AssertionError(f'Unsupported PCM width {width}; inspect artifact manually.')
                    audio = np.frombuffer(raw, dtype={1: 'u1', 2: '<i2', 4: '<i4'}[width]).astype('float32')
                    audio = (audio - 128) / 128 if width == 1 else audio / (2 ** (width * 8 - 1))
                    audio = audio.reshape(-1, channels)
                    evidence.update(sample_rate=rate, channels=audio.shape[1], frames=len(audio), duration=len(audio) / rate,
                                    peak=float(np.max(np.abs(audio))) if audio.size else 0,
                                    rms=float(np.sqrt(np.mean(audio ** 2))) if audio.size else 0,
                                    finite=bool(np.all(np.isfinite(audio))))
                elif destination.suffix in {'.txt', '.json'}:
                    evidence['text_excerpt'] = blob.decode('utf-8', errors='replace')[:1000]
                result['artifacts'].append(evidence)
            expected = case.get('expect', 'done')
            if job['status'] != expected or result.get('timeout'):
                raise AssertionError(f"Expected {expected}; got {job['status']}: {job.get('message')}")
            if case.get('contains') and case['contains'] not in job.get('message', '') + job.get('text', ''):
                raise AssertionError('Expected text missing: ' + case['contains'])
            if expected == 'done':
                audio_artifacts = [artifact for artifact in result['artifacts'] if 'duration' in artifact]
                separation = case['task'] == 'separation'
                if case.get('action', 'generate') == 'generate' and case['task'] != 'asr' and not result['artifacts']:
                    raise AssertionError('Successful generation returned no downloadable artifact.')
                if case.get('action', 'generate') == 'generate' and case['task'] in {'tts', 'music', 'design', 'vc', 'processing', 'separation'} and not audio_artifacts:
                    raise AssertionError('Successful audio generation returned no audio artifact.')
                if len(result['artifacts']) < case.get('min_artifacts', 0):
                    raise AssertionError('Missing expected multi-output artifacts.')
                if separation and len(audio_artifacts) < case.get('min_artifacts', 1):
                    raise AssertionError('Missing expected separated audio tracks.')
                if case['task'] == 'asr' and not job.get('text', '').strip():
                    raise AssertionError('ASR returned an empty transcript.')
                for artifact in result['artifacts']:
                    if not artifact['bytes']:
                        raise AssertionError('Empty output artifact.')
                    if 'duration' in artifact:
                        if artifact['frames'] <= 0 or artifact['sample_rate'] <= 0 or artifact['channels'] <= 0 or not artifact['finite']:
                            raise AssertionError('Audio has invalid frames, format or non-finite samples.')
                        if not separation and (artifact['duration'] < .05 or artifact['peak'] < 1e-6):
                            raise AssertionError('Audio is empty or silent.')
                if separation and not any(artifact['peak'] >= 1e-6 for artifact in audio_artifacts):
                    raise AssertionError('All separated audio tracks are silent.')
                if case.get('stream_required') and not segment_count:
                    raise AssertionError('Streaming returned no PCM deltas.')
                expected_rate = result['detail'].get('profile', {}).get('stream_sample_rate')
                if case.get('stream_required') and expected_rate and sample_rates != {expected_rate}:
                    raise AssertionError(f'Stream sample rates {sample_rates} differ from profile {expected_rate}.')
            result['verdict'] = 'PASS'
        except Exception as error:
            result['error'] = f'{type(error).__name__}: {error}'
            print('  FAIL ' + result['error'], flush=True)
        finally:
            result['elapsed'] = round(time.monotonic() - start, 2)
            if not case.get('skip_reason') and result['verdict'] not in {'BLOCKED', 'PENDING'}:
                try:
                    result['runtime'] = request('GET', '/status', timeout=10)
                    log = Path('webui/logs/audiocpp_server_webui.log')
                    if log.is_file():
                        saved_log = args.output / 'logs' / (ident + '.log')
                        saved_log.parent.mkdir(parents=True, exist_ok=True)
                        saved_log.write_bytes(log.read_bytes())
                        result['backend_log'] = str(saved_log.resolve())
                except Exception as error:
                    result['evidence_warning'] = str(error)
            destination = args.output / 'cases' / (ident + '.json')
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
                history = destination.parent / 'attempts' / f'{ident}-{stamp}.json'
                history.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(destination, history)
            destination.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            update_summary(args.output)
            print(f"END {ident} {result['verdict']} {result['elapsed']}s", flush=True)
        # Keep one resident model only; release memory even after an error.
        state = request('GET', '/status', timeout=10)
        if state['busy']:
            print('STOP: workspace still occupied.', flush=True)
            return 2
        request('POST', '/unload-all', json={})
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
