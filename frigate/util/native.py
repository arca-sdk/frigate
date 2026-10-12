"""Optional Rust implementations of per-frame hot paths.

The ``frigate_native`` extension is built from ``rust/frigate_native``. Each
function returns the same result as the Python code it replaces, and returns
None for inputs it does not handle so the caller can fall back to Python.

Set ``FRIGATE_DISABLE_NATIVE=1`` to force the Python implementations, for
example to compare behavior or rule the extension out while debugging.
"""

import os
from types import ModuleType


def _load_native() -> ModuleType | None:
    if os.environ.get("FRIGATE_DISABLE_NATIVE", "").lower() in ("1", "true", "yes"):
        return None

    try:
        import frigate_native
    except ImportError:
        return None

    return frigate_native


native = _load_native()
