"""Check model-spec coverage of C++ runtime options, without loading any weights.

Legacy loaders advertise options in C++ rather than model_specs. Also inspect
precision/cache/workspace keys used by sessions, including keys absent from CLI
help. This is a source-contract check, not a substitute for model/backend tests.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
STRING = r'"(?:[^"\\]|\\.)*"'
ENTRY = re.compile(r'\{\s*(' + STRING + r')\s*,\s*(' + STRING + r')\s*,\s*((?:' + STRING + r'\s*)+)')
RUNTIME_KEY = re.compile(r'^[a-z0-9_]+\.(?:\w*weight_type|\w*(?:context|arena)_mb|\w*cache_slots|mem_saver|threads|attention|attention_tile_rows)$')


def source_files(root, family):
    for base in ("src/models", "src/community_models"):
        directory = root / base / family
        if family in {"moss_tts_local", "moss_tts_nano"}:
            directory = root / base / "moss" / family
        yield from sorted(directory.rglob("*.cpp"))


def cpp_options(text, family):
    """Read literal CLI declarations; preserve adjacent C++ string literals."""
    rows = {}
    for scope, body in re.findall(r'\.(session|load)_options\s*=\s*\{(.*?)\};', text, re.S):
        for match in ENTRY.finditer(body):
            name, kind = json.loads(match[1]), json.loads(match[2])
            if not name.startswith(family + "."):
                continue  # e.g. the legacy vibevoice_asr_streaming namespace
            description = "".join(json.loads(s) for s in re.findall(STRING, match[3]))
            rows[(scope, name)] = {"name": name, "value_name": kind, "description": description}
    return rows


def compatibility_aliases(text, family):
    aliases = {}
    for body in re.findall(r'apply_option_v1_compatibility\s*\((.*?)\);', text, re.S):
        for old, new in re.findall(r'\{\s*"([\w.]+)"\s*,\s*"([\w.]+)"\s*\}', body):
            if old.startswith(family + ".") and new.startswith(family + "."):
                aliases[old] = new
    # find_option lists put the preferred spelling first.
    for body in re.findall(r'(?:find_option(?:_match)?|parse_\w+_option|option_weight_type)\([^;{}]*\{\s*("' + re.escape(family) + r'\.[\w.]+"(?:\s*,\s*"[\w.]+")+)\s*\}', text):
        names = re.findall(r'"([\w.]+)"', body)
        for second in names[1:]:
            if second.startswith(family + ".") and names[0] not in aliases and second not in aliases:
                aliases[second] = names[0]
    return aliases


def scan(root=ROOT):
    catalog = json.loads((root / "webui/configs/models_catalog.json").read_text(encoding="utf-8"))["models"]
    local = json.loads((root / "webui/configs/model_params.json").read_text(encoding="utf-8"))
    exclusions_path = root / "tools/runtime_option_exclusions.json"
    exclusions = json.loads(exclusions_path.read_text(encoding="utf-8")) if exclusions_path.exists() else {}
    reports = {}
    for family in sorted({m["family"] for m in catalog}):
        path = root / "model_specs" / (family + ".json")
        spec = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        text = "\n".join(p.read_text(encoding="utf-8") for p in source_files(root, family))
        declared = {}
        if not path.exists():  # bundled VAD loaders intentionally have no package spec
            for option in local.get(family, []):
                for scope in ("session", "load"):
                    if option["name"].startswith(scope + "_options."):
                        declared[(scope, option["name"].split("_options.", 1)[1])] = option
        for scope in ("session", "load", "request"):
            for option in spec.get("options", {}).get(scope, []):
                key = option["name"]
                key = key if key.startswith(family + ".") else family + "." + key
                declared[(scope, key)] = option
        aliases = compatibility_aliases(text, family)
        rows = cpp_options(text, family)
        keys = {s for s in re.findall(r'"([\w.]+)"', text) if s.startswith(family + ".") and RUNTIME_KEY.fullmatch(s)}
        for body in re.findall(r'(?:parse_\w+_option|find_option(?:_match)?)\(\s*(?:options\.options|options\(\)\.options)\s*,\s*\{([^}]+)\}', text):
            keys.update(s for s in re.findall(r'"([\w.]+)"', body) if s.startswith(family + "."))
        missing = []
        for (scope, name), row in rows.items():
            if (scope, name) not in declared and name not in exclusions and name not in aliases:
                missing.append({"scope": scope, **row})
        covered = {name for _, name in declared} | {name for _, name in rows} | set(aliases) | set(exclusions)
        for name in sorted(keys - covered):
            missing.append({"scope": "session", "name": name})
        errors = []
        for (scope, name), row in rows.items():
            option = declared.get((scope, name))
            kind = row["value_name"]
            if option and "|" in kind and kind != "true|false" and option.get("type") == "enum":
                if option.get("values") and set(option["values"]) != set(kind.split("|")):
                    errors.append(f"{name}: enum differs from C++ CLI declaration")
        for old, current in aliases.items():
            if old in keys and current not in {name for _, name in declared} and old not in exclusions:
                errors.append(f"{old}: canonical option {current} is not declared")
        if missing or errors:
            reports[family] = {"missing": missing, "errors": errors}
    return reports


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    reports = scan()
    if args.json:
        print(json.dumps(reports, ensure_ascii=False, indent=2))
    else:
        for family, report in reports.items():
            for option in report["missing"]:
                print(f"missing: {family} {option['scope']} {option['name']}")
            for error in report["errors"]:
                print(f"mismatch: {family} {error}")
        print(f"Runtime-option coverage: {len(reports)} families need attention" if reports else "Runtime-option coverage: all catalog families checked")
    return bool(reports)


if __name__ == "__main__":
    raise SystemExit(main())
