"""Read-only status surface for the DeepSeek Harness customization layer.

**This is not the product UI.** The application's interface is DeepSeek Harness
itself (the ``dsh`` web client started by ``scripts/launch.ps1``). What lives here is
a small, optional viewer that renders exactly the status
:func:`prototype.main.collect` measured:

* no agent run, no model call, no file edit, no listening socket;
* no fabricated diff, token count, cost, "PASSED" word or savings comparison;
* a missing endpoint shows as ``NOT CONFIGURED`` with its reason, never as a
  placeholder host or model.

Three entry points are used elsewhere in the project:

``tail(text, limit)``
    Bounded tail of a captured stream, with the omitted length stated.
``render_text(status)``
    The same status as plain text, for the terminal pre-flight.
``launch(status)``
    The optional Tk window (standard library only). Nothing is editable and no
    request is made; closing the window is the only action.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

#: Characters of a captured stream kept when a verification record is shown.
TAIL_LIMIT = 4000

_TK_HINT = (
    "the optional status window needs tkinter, which this Python build does not "
    "provide; use the text output (python -m prototype.main) instead"
)


def tail(text: str, limit: int = TAIL_LIMIT) -> str:
    """Bounded tail of a captured stream; the omitted count is stated, not hidden."""
    body = text or ""
    if len(body) <= limit:
        return body
    return f"[...{len(body) - limit} chars omitted...]\n" + body[-limit:]


def _unknown(value: Optional[Any]) -> str:
    return "unknown" if value is None else str(value)


def render_text(status: Dict[str, Any]) -> str:
    """Plain-text rendering of :func:`prototype.main.collect` output."""
    if not status:
        return "status unavailable: nothing was measured"
    if "error" in status:
        return f"status unavailable: {status['error']}"
    if not status.get("hardware") or not status.get("route"):
        return (
            "status unavailable: the payload did not contain measured hardware and route "
            "fields, so nothing is rendered (an empty report is never substituted)"
        )

    hardware = status.get("hardware") or {}
    tier = status.get("tier") or {}
    route = status.get("route") or {}
    preset = status.get("preset") or {}
    memory = status.get("memory") or {}
    launcher = status.get("launcher") or {}

    gpu = hardware.get("gpu_name") or "none"
    graphics = (
        f"{gpu} ({hardware.get('vram_gb', '?')} GB VRAM)"
        if hardware.get("has_gpu")
        else f"{gpu} — CPU only"
    )
    lines: List[str] = [
        "DeepSeek Harness — customization layer pre-flight",
        "  (the application UI is dsh; this command only reports measured status)",
        "",
        f"hardware : {_unknown(hardware.get('cpu_cores'))} cores / "
        f"{_unknown(hardware.get('ram_gb'))} GB RAM / {graphics}",
        f"tier     : {_unknown(tier.get('label'))} — quantization "
        f"{_unknown(tier.get('quantization'))}, local preset "
        f"{_unknown(tier.get('registry_model_id'))}",
        f"preset   : {_unknown(preset.get('selected_model'))} "
        f"(release {_unknown(preset.get('release_version'))}, "
        f"gateway {_unknown(preset.get('gateway_mode'))}, "
        f"background {_unknown(preset.get('background_model_id') or 'none')})",
        f"preset src: {_unknown(preset.get('selection_source'))}",
    ]
    if route.get("configured"):
        lines.append(
            f"route    : {route.get('route')} -> endpoint {route.get('endpoint_host')} "
            f"requested model {route.get('requested_model') or '(per node, from the planner)'} "
            f"(api key {'present' if route.get('api_key_present') else 'not required'})"
        )
    else:
        lines.append(
            f"route    : NOT CONFIGURED — {route.get('reason')} (no request will be sent)"
        )
    lines.append(f"memory   : {memory.get('mode', 'unknown')} — {memory.get('detail', '')}")

    track = status.get("track")
    if isinstance(track, dict):
        if track.get("error"):
            lines.append(f"track    : unavailable — {track['error']}")
        else:
            lines.append(
                f"track    : {track.get('track')} (fast_path={track.get('fast_path')}, "
                f"complexity={track.get('complexity')}) from {track.get('source')}"
            )

    lines.extend(
        [
            "",
            f"launcher : {launcher.get('path', 'unknown')} "
            f"({'present' if launcher.get('present') else 'MISSING'})",
            "next     : python -m prototype.main --launch -- -ModelPatch   "
            "# starts dsh with the customization patch",
            "",
            "Reported values are measured or explicitly unknown: no run, token count, cost",
            "or verification result is invented here.",
        ]
    )
    return "\n".join(lines)


def launch(status: Dict[str, Any], title: str = "DeepSeek Harness — status") -> int:
    """Open the optional read-only status window. Makes no request, binds no socket."""
    try:
        import tkinter as tk
        from tkinter import ttk
    except Exception as exc:  # tkinter absent in this build
        raise RuntimeError(f"{_TK_HINT} ({type(exc).__name__})") from exc

    root = tk.Tk()
    root.title(title)
    root.geometry("1000x640")
    root.minsize(760, 480)
    root.columnconfigure(0, weight=1)
    root.rowconfigure(1, weight=1)

    header = ttk.Frame(root, padding=(10, 8, 10, 0))
    header.grid(row=0, column=0, sticky="ew")
    header.columnconfigure(0, weight=1)
    ttk.Label(header, text="Status (measured — read only)", font=("Segoe UI", 12, "bold")).grid(
        row=0, column=0, sticky="w"
    )
    ttk.Label(
        header,
        text="The application UI is dsh. This window only displays what the engine measured; "
             "it starts no run and makes no network call.",
        font=("Segoe UI", 9),
        wraplength=940,
        justify="left",
    ).grid(row=1, column=0, sticky="w", pady=(2, 0))

    body = ttk.Frame(root, padding=(10, 8, 10, 10))
    body.grid(row=1, column=0, sticky="nsew")
    body.columnconfigure(0, weight=1)
    body.rowconfigure(0, weight=1)

    text = tk.Text(body, wrap="word", font=("Consolas", 9))
    text.grid(row=0, column=0, sticky="nsew")
    scroll = ttk.Scrollbar(body, orient="vertical", command=text.yview)
    scroll.grid(row=0, column=1, sticky="ns")
    text.configure(yscrollcommand=scroll.set)
    text.insert("1.0", render_text(status))
    text.configure(state="disabled")

    ttk.Button(root, text="Close", command=root.destroy).grid(row=2, column=0, sticky="e", padx=10, pady=(0, 10))
    root.protocol("WM_DELETE_WINDOW", root.destroy)
    root.mainloop()
    return 0

