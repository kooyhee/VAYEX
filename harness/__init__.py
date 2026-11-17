"""Optional Python-side status surface for the local harness engine.

This package holds no product UI: ``harness.ui`` only renders status that
:func:`prototype.main.collect` measured (hardware, tier, route, preset, two-track
label) as text or in an optional read-only Tk window. It starts no run, makes no
network call, opens no socket, and never invents a diff, token count, cost or
verification result.
"""
