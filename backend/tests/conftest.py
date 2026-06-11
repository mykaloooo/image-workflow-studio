"""
Shared pytest fixtures for the generation-history backend tests.

Makes the ``backend/`` directory importable so test modules can simply do
``from history_store import HistoryStore`` without installing the project.
"""

from __future__ import annotations

import os
import sys
from typing import Iterator

import pytest

# Put backend/ on sys.path so ``import history_store`` works no matter where
# pytest is invoked from (repo root vs backend/).
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)


@pytest.fixture
def jsonl_path(tmp_path) -> Iterator[str]:
    """Return a fresh JSONL path inside pytest's tmp_path."""
    path = tmp_path / "generation_history.jsonl"
    yield str(path)
