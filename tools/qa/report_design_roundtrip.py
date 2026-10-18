"""Read the separate voice-design content report; no inference."""
import sys

from report_vc_roundtrip import main


if __name__ == "__main__":
    if "--manifest" not in sys.argv:
        sys.argv.extend(["--manifest", "build/functional-qa-20261008/design-roundtrip-cases.json"])
    sys.argv.extend(["--kind", "design"])
    raise SystemExit(main())
