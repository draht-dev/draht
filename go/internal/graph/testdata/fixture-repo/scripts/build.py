"""Exercises python import extraction. Per design D3, python imports are
extracted and cached but never turned into edges[] (edges are TS/JS only in
Phase 1) — this file's presence checks that non-edged languages still
produce a correct module with populated Facts.Imports internally.
"""
import os
import sys
from pathlib import Path


def main() -> None:
    print(os.getcwd(), sys.argv, Path("."))


if __name__ == "__main__":
    main()
