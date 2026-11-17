"""Python pre-flight / status helper for the local harness engine.

This module is not a UI. It opens no window, runs no agent loop and binds no socket.
It exists so a person or a script can ask, in one command:

* which hardware is detected and which execution tier that maps to
  (:func:`engine.hardware_profiler.detect_hardware` /
  :func:`engine.hardware_profiler.determine_local_tier`),
* which curated preset a fresh session would start with
  (:meth:`engine.registry.ModelIntelligenceRegistry.app_bundle_info`),
* which execution route and endpoint host are active, resolved exactly as
  :meth:`engine.lm_client.LmClient.from_env` resolves them — or an explicit
  "not configured" reason with no placeholder host or model,
* which of the two tracks a prompt takes
  (:meth:`engine.decision_planner.IntelligencePlanner.classify_execution_track`),
* and, with ``--launch``, to start the real runtime through ``launch.ps1``.

Honesty rules in force here: no fabricated diff, token count, cost, "PASSED" string
or savings comparison; a missing value is reported as unknown or as an explicit
reason, and the API key is only ever reported by *presence*, never by value.

Usage::

    python -m prototype.main                 # human-readable pre-flight
    python -m prototype.main --json          # one JSON object on stdout
    python -m prototype.main --track --prompt "fix the typo in src/app.py"
    python -m prototype.main --launch -- -DryRun    # passthrough to launch.ps1
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence
from urllib.parse import urlsplit

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from engine import lm_client as lm  # noqa: E402
from engine.decision_planner import ExecutionRoute, IntelligencePlanner  # noqa: E402
from engine.hardware_profiler import detect_hardware, determine_local_tier  # noqa: E402
from engine.registry import ModelIntelligenceRegistry  # noqa: E402
from harness import ui  # noqa: E402

SCHEMA = "harness-status/1"
ROUTES = tuple(route.value for route in ExecutionRoute)
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
LAUNCHER = _PROJECT_ROOT / "launch.ps1"


def _netloc(url: str) -> str:
    try:
        return urlsplit(url).netloc or ""
    except ValueError:
        return ""


def _host(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").strip().lower()
    except ValueError:
        return ""


def endpoint_status() -> Dict[str, Any]:
    """Resolve the endpoint the way ``LmClient.from_env`` does, without calling it."""
    route = (os.environ.get(lm.ENV_ROUTE) or ExecutionRoute.ZDR_CLOUD.value).strip()
    base = (os.environ.get(lm.ENV_BASE_URL) or "").strip()
    local = (os.environ.get(lm.ENV_LOCAL_BASE_URL) or "").strip()
    model = (os.environ.get(lm.ENV_MODEL) or "").strip()
    key_present = bool((os.environ.get(lm.ENV_API_KEY) or "").strip())
    effective = (local or base) if route == ExecutionRoute.LOCAL_ONLY.value else base

    reason = ""
    if route not in ROUTES:
        reason = f"route {route!r} is not one of {', '.join(ROUTES)}"
    elif not effective:
        reason = f"no endpoint configured: set {lm.ENV_BASE_URL}" + (
            f" (or {lm.ENV_LOCAL_BASE_URL} for local_only)"
            if route == ExecutionRoute.LOCAL_ONLY.value
            else ""
        )
    elif route == ExecutionRoute.LOCAL_ONLY.value and _host(effective) not in _LOOPBACK_HOSTS:
        reason = "local_only requires a loopback endpoint host"
    elif route != ExecutionRoute.LOCAL_ONLY.value and not key_present:
        reason = f"no API key configured: set {lm.ENV_API_KEY}"
    return {
        "route": route,
        "route_valid": route in ROUTES,
        "endpoint_url": effective,
        "endpoint_host": _netloc(effective),
        "requested_model": model,
        "api_key_present": key_present,
        "configured": not reason,
        "reason": reason,
    }


def preset_status(
    registry: ModelIntelligenceRegistry,
    route: str,
    tier_info: Any,
) -> Dict[str, Any]:
    """Curated app preset from ``registry.app_bundle_info``."""
    bundle = dict(registry.app_bundle_info())
    return {
        "release_version": bundle.get("release_version", "unknown"),
        "gateway_mode": bundle.get("gateway_mode", "unknown"),
        "primary_model": bundle.get("primary_model", "unknown"),
        "update_policy": bundle.get("update_policy", "unknown"),
        "selected_model": bundle.get("primary_model", ""),
        "background_model_id": "",
        "endpoint_env": {},
        "selection_source": "registry.app_bundle_info (primary model)",
    }


def memory_status() -> Dict[str, str]:
    """Background memory layer: only a configured local endpoint may call a model."""
    local = (os.environ.get(lm.ENV_LOCAL_BASE_URL) or "").strip()
    if not local and (os.environ.get(lm.ENV_ROUTE) or "").strip() == ExecutionRoute.LOCAL_ONLY.value:
        local = (os.environ.get(lm.ENV_BASE_URL) or "").strip()
    if local and _host(local) in _LOOPBACK_HOSTS:
        model = (os.environ.get(lm.ENV_MODEL) or "").strip()
        return {
            "mode": "local_model" if model else "extractive_only",
            "detail": f"local endpoint {_netloc(local)} configured"
            + ("" if model else f"; no {lm.ENV_MODEL} set, so no background call is possible"),
        }
    return {
        "mode": "extractive_only",
        "detail": (
            "no local endpoint configured — HybridContextMemoryEngine.distill_and_summarize() "
            "uses its deterministic extractive summarizer and makes no model call"
        ),
    }


def track_status(prompt: str, registry: ModelIntelligenceRegistry) -> Dict[str, Any]:
    """Two-track label, fast-path flag and complexity, all from the planner."""
    prompt = (prompt or "").strip()
    if not prompt:
        return {"error": "empty prompt: no track can be classified"}
    planner = IntelligencePlanner(registry)
    return {
        "track": planner.classify_execution_track(prompt),
        "fast_path": bool(planner.is_simple_task(prompt)),
        "complexity": int(planner.estimate_complexity(prompt)),
        "source": "engine.decision_planner.IntelligencePlanner.classify_execution_track",
        "prompt_chars": len(prompt),
    }


def collect(prompt: Optional[str] = None) -> Dict[str, Any]:
    """Everything the helper reports, measured or explicitly unknown."""
    registry = ModelIntelligenceRegistry()
    spec = detect_hardware()
    tier = determine_local_tier(spec)
    endpoint = endpoint_status()

    hardware = spec.to_dict()
    tier_info = {
        "value": tier.tier.value,
        "level": tier.tier.level,
        "label": f"Tier {tier.tier.level} ({tier.tier.value})",
        "quantization": tier.quantization,
        "registry_model_id": tier.registry_model_id,
        "recommended_models": list(tier.recommended_models),
        "capability_tier": tier.capability_tier.value if tier.capability_tier else None,
    }
    status: Dict[str, Any] = {
        "schema": SCHEMA,
        "hardware": hardware,
        "tier": tier_info,
        "route": endpoint,
        "preset": preset_status(registry, endpoint["route"], tier),
        "memory": memory_status(),
        "launcher": {"path": str(LAUNCHER), "present": LAUNCHER.is_file()},
    }
    if prompt is not None:
        status["track"] = track_status(prompt, registry)
    return status


def launch_runtime(extra: Sequence[str]) -> int:
    """Start the real runtime through ``launch.ps1``; report its exit code."""
    if not LAUNCHER.is_file():
        print(f"launcher missing: {LAUNCHER}", file=sys.stderr)
        return 2
    if os.name != "nt":
        print(
            "launch.ps1 needs PowerShell (Windows)",
            file=sys.stderr,
        )
        return 2
    command = [
        "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", str(LAUNCHER), *extra,
    ]
    completed = subprocess.run(command, cwd=str(_PROJECT_ROOT))
    return int(completed.returncode)


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m prototype.main",
        description=(
            "Local harness pre-flight/status helper; "
            "prints measured status or starts the omp runtime."
        ),
        epilog=(
            "Examples:\n"
            "  python -m prototype.main --json\n"
            '  python -m prototype.main --track --prompt "add a test for divide"\n'
            "  python -m prototype.main --launch -- -DryRun\n"
            "  python -m prototype.main --launch -- -Port 4317"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--json", action="store_true", help="print one JSON object instead of text")
    parser.add_argument("--track", action="store_true",
                        help="classify the two-track label for --prompt (or $HARNESS_PROMPT)")
    parser.add_argument("--prompt", default=None,
                        help="prompt to classify; implies --track; defaults to $HARNESS_PROMPT")
    parser.add_argument("--view", action="store_true",
                        help="open the optional read-only Tk status window (no calls, no sockets)")
    parser.add_argument("--launch", action="store_true",
                        help="run launch.ps1 (everything after -- is passed to it)")
    parser.add_argument("passthrough", nargs=argparse.REMAINDER,
                        help="arguments forwarded to launch.ps1 (after --)")
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)

    if args.launch:
        extra = list(args.passthrough)
        if extra and extra[0] == "--":
            extra = extra[1:]
        return launch_runtime(extra)

    prompt: Optional[str] = None
    if args.track or args.prompt is not None:
        prompt = args.prompt if args.prompt is not None else os.environ.get("HARNESS_PROMPT", "")

    try:
        status = collect(prompt)
    except Exception as exc:  # a half-measured status must never be rendered as fact
        payload = {"schema": SCHEMA, "error": f"{type(exc).__name__}: {exc}"}
        if args.json:
            print(json.dumps(payload, ensure_ascii=False))
        else:
            print(f"status unavailable: {payload['error']}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(status, ensure_ascii=False))
        return 0

    if args.view:
        return ui.launch(status)

    print(ui.render_text(status))
    track = status.get("track") or {}
    return 0 if not track.get("error") else 2


if __name__ == "__main__":
    raise SystemExit(main())

