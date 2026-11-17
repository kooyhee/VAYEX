"""Python pre-flight/status helper for the local harness engine.

This package only reports status that the engine measured
(``python -m prototype.main``), or starts the runtime through ``launch.ps1``
(``--launch``). No agent loop, window or socket lives here, and no number is
invented.
"""
