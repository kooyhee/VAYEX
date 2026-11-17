"""Python pre-flight/status helper for the DeepSeek Harness customization layer.

The application's UI is DeepSeek Harness (``dsh``). This package only reports status
that the engine measured (``python -m prototype.main``), or starts the runtime
through ``scripts/launch.ps1`` (``--launch``). No agent loop, window or socket lives
here, and no number is invented.
"""
