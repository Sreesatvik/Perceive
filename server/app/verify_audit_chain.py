"""
Phase D.2 / Step 5 — standalone tamper-detection tool for the hash-chained
audit log. Reads a JSONL audit log file, parses each line, and runs it
through logger.verify_audit_chain() (the same verification logic exercised
by the regression test in server/tests/test_audit_chain_tamper.py).

Usage:
    python -m app.verify_audit_chain [path/to/audit.jsonl]

Exits 0 and prints "CHAIN OK" if every entry verifies; exits 1 and prints
the index (and raw content) of the first broken entry otherwise, so an
operator (or the test suite) can immediately identify which line was
tampered with, deleted, or reordered.
"""
import json
import sys

from .logger import verify_audit_chain, LOG_FILE


def load_entries(path: str) -> list[dict]:
    entries = []
    with open(path, "r", encoding="utf-8") as f:
        for line_number, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise ValueError(f"Line {line_number} is not valid JSON: {e}") from e
    return entries


def main(argv: list[str]) -> int:
    path = argv[1] if len(argv) > 1 else LOG_FILE
    try:
        entries = load_entries(path)
    except FileNotFoundError:
        print(f"CHAIN CHECK FAILED: no such file: {path}")
        return 1
    except ValueError as e:
        print(f"CHAIN CHECK FAILED: {e}")
        return 1

    ok, broken_index = verify_audit_chain(entries)

    if ok:
        print(f"CHAIN OK — {len(entries)} entries verified, unbroken from genesis to tip.")
        return 0

    print(f"CHAIN BROKEN at entry index {broken_index} (line {broken_index + 1} of {path}).")
    if 0 <= broken_index < len(entries):
        print("Offending entry:")
        print(json.dumps(entries[broken_index], indent=2))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
