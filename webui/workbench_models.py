"""Deletion of the current local model installation, independent of UI metadata."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import stat


def _linked(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def _target(backend, entry):
    raw = entry.get('abs_path')
    if not raw or not Path(raw).is_absolute():
        raise ValueError('没有可删除的本地模型目录。')
    path = Path(os.path.abspath(raw))
    roots = getattr(backend, 'MODEL_SEARCH_ROOTS', ()) or (getattr(backend, 'MODELS_ROOT', ''),)
    roots = [Path(os.path.abspath(root)) for root in roots if root]
    root = next((root for root in roots if path != root and path.is_relative_to(root)), None)
    if root is None or any(path == root or root.is_relative_to(path) for root in roots):
        raise ValueError('此路径不在可管理的模型子目录内，请手动管理该模型文件。')
    # Reject links/junctions both above and below the selected directory. Never
    # turn a catalog path or a Windows reparse point into an outside-tree delete.
    for part in (path, *path.parents):
        if _linked(part):
            raise ValueError('模型路径含符号链接或目录联接，请手动管理该路径。')
    resolved = path.resolve(strict=True)
    if resolved == root.resolve() or not resolved.is_relative_to(root.resolve()):
        raise ValueError('模型路径超出模型目录。')
    # Protect user/config data even if a custom models root contains the app.
    for key in ('CONFIG_DIR', 'OUTPUT_DIR', 'VOICE_DIR'):
        protected = getattr(backend, key, None)
        if protected:
            protected = Path(protected).resolve()
            if resolved == protected or protected.is_relative_to(resolved) or resolved.is_relative_to(protected):
                raise ValueError('该目录包含应用配置、音色或输出文件，不能作为模型删除。')
    return resolved


def deletion_available(backend, entry):
    try:
        _target(backend, entry)
        return True
    except (OSError, ValueError, RuntimeError):
        return False


def deletion_plan(backend, entry):
    path = _target(backend, entry)
    affected = []
    for other in backend.catalog_models():
        references = [other.get('abs_path'), other.get('gguf_path'), *other.get('source_roots', {}).values()]
        if any(value and (Path(value).resolve() == path or Path(value).resolve().is_relative_to(path)
                          or path.is_relative_to(Path(value).resolve())) for value in references):
            affected.append({'id': other['id'], 'label': other['label']})
    records, size, files = [], 0, 0

    def inspect(item):
        nonlocal size, files
        if _linked(item):
            raise ValueError('模型目录内含符号链接或目录联接，请手动管理该路径。')
        info = item.stat()
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise ValueError('模型目录含特殊文件，不能自动删除。')
        records.append((str(item.relative_to(path)), info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns))
        if item.is_file():
            files += 1
            size += info.st_size

    inspect(path)
    if path.is_dir():
        def failed(error):
            raise error
        for directory, dirs, names in os.walk(path, followlinks=False, onerror=failed):
            for name in sorted(dirs + names):
                inspect(Path(directory) / name)
    signature = json.dumps([str(path), sorted(records), sorted(item['id'] for item in affected)], ensure_ascii=False)
    return {'model': entry['id'], 'label': entry['label'], 'path': str(path), 'affected': affected,
            'bytes': size, 'files': files, 'token': hashlib.sha256(signature.encode()).hexdigest()}


def delete_installation(backend, entry, token):
    plan = deletion_plan(backend, entry)
    if not token or token != plan['token']:
        raise RuntimeError('模型文件或关联入口已变化，请重新查看删除范围后确认。')
    path = Path(plan['path'])
    try:
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
    except OSError as error:
        raise RuntimeError('删除未完成，部分文件可能已删除；请关闭占用文件的程序后刷新并重试。') from error
    return {'message': '本地模型文件已删除；参数配置、音色库和生成结果已保留。',
            'affected': plan['affected']}
