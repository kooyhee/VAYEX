"""Single customization payload for the DSH (``@deepseek-ai/dsh``) launcher.

The launcher is Node/PowerShell and must not re-implement routing. This module is the
one call it makes: it reports the detected hardware tier, the preset model DSH should
start with, the execution route, and the two-track classification of a prompt.

Contract::

    build_customization_payload(prompt="", route=None, hardware_tier=None,
                                privacy_consent=False) -> dict

    python -m engine.dsh_payload --prompt "..." [--route local_only]
                                 [--tier standard_local] [--consent]
                                 [--json-pretty]      # one JSON object on stdout

An explicit ``route`` wins. Otherwise the deprecated consent boolean alone selects
the route: ``False`` -> ``local_only`` (no cloud route without consent), ``True`` ->
``zdr_cloud`` (the narrowest cloud route, never ``any_cloud``). Consent and route
stay independent: ``privacy_consent`` in the payload reports the caller's flag and
is never derived back from the route.

Every value comes from ``engine.hardware_profiler``, ``engine.registry`` and
``engine.decision_planner``; nothing is estimated here and no secret is emitted
(the endpoint is named by environment variable, never by value).
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, Optional, Sequence, Union

from .decision_planner import ExecutionRoute, IntelligencePlanner
from .hardware_profiler import (
    LocalExecutionTier,
    LocalExecutionTierInfo,
    detect_hardware,
    determine_local_tier,
    parse_tier,
)
from .registry import ModelIntelligenceRegistry

__all__ = ["PAYLOAD_SCHEMA", "build_customization_payload", "render_payload", "main"]

PAYLOAD_SCHEMA = "harness.dsh_customization/1"

ENV_CLOUD_BASE = "HARNESS_LLM_BASE_URL"
ENV_CLOUD_KEY = "HARNESS_LLM_API_KEY"
ENV_CLOUD_MODEL = "HARNESS_LLM_MODEL"
ENV_LOCAL_BASE = "HARNESS_LOCAL_BASE_URL"
ENV_LOCAL_MODEL = "HARNESS_LOCAL_MODEL"
ENV_LOCAL_KEY = "HARNESS_LOCAL_API_KEY"


def _resolve_tier(
    hardware_tier: Optional[Union[str, LocalExecutionTier, LocalExecutionTierInfo]],
) -> LocalExecutionTierInfo:
    if isinstance(hardware_tier, LocalExecutionTierInfo):
        return hardware_tier
    spec = detect_hardware()
    if hardware_tier is None:
        return determine_local_tier(spec)
    return determine_local_tier(spec, override_tier=str(parse_tier(hardware_tier).value))


def _selected_model(
    registry: ModelIntelligenceRegistry,
    planner: IntelligencePlanner,
    route: ExecutionRoute,
    tier_info: LocalExecutionTierInfo,
) -> Optional[str]:
    """Model DSH should start a session with, or ``None`` when the route has none."""
    if route == ExecutionRoute.LOCAL_ONLY:
        # Tier 0 has no local LLM: local_only cannot be served, so report no model
        # rather than naming one the machine cannot run.
        return tier_info.registry_model_id if tier_info.uses_local_llm else None
    if route == ExecutionRoute.ANY_CLOUD:
        return planner.select_decision_model("main", mode="balanced", complexity=5, privacy_consent=True)
    return registry.app_bundle_info()["primary_model"]


def _background_model_id(registry: ModelIntelligenceRegistry, tier_info: LocalExecutionTierInfo) -> Optional[str]:
    """Local model a background task (compaction, titles, distillation) should use."""
    selection = registry.select_background_model(tier=tier_info.tier)
    return selection.model_id if selection.is_ready else None


def build_customization_payload(
    prompt: str = "",
    route: Union[str, ExecutionRoute, None] = None,
    hardware_tier: Optional[Union[str, LocalExecutionTier, LocalExecutionTierInfo]] = None,
    privacy_consent: bool = False,
    registry: Optional[ModelIntelligenceRegistry] = None,
    planner: Optional[IntelligencePlanner] = None,
) -> Dict[str, Any]:
    """Build the JSON-serializable customization payload consumed by the DSH launcher."""
    registry = registry or ModelIntelligenceRegistry()
    planner = planner or IntelligencePlanner(registry)
    effective_route = (ExecutionRoute(route) if route is not None
                       else ExecutionRoute.from_privacy_consent(privacy_consent))
    tier_info = _resolve_tier(hardware_tier)
    text = (prompt or "").strip()

    track = planner.classify_execution_track(text) if text else None
    complexity = planner.estimate_complexity(text) if text else None
    payload: Dict[str, Any] = {
        "schema": PAYLOAD_SCHEMA,
        "release_version": registry.app_bundle_info()["release_version"],
        "route": effective_route.value,
        "privacy_consent": bool(privacy_consent),
        "tier": {
            "name": tier_info.tier.value,
            "uses_local_llm": tier_info.uses_local_llm,
            "local_model_id": tier_info.registry_model_id,
            "quantization": tier_info.quantization,
            "override_applied": tier_info.override_applied,
        },
        "selected_model": _selected_model(registry, planner, effective_route, tier_info),
        "background_model_id": _background_model_id(registry, tier_info),
        "track": track,
        "complexity": complexity,
        "target_files": planner.detect_target_files(text) if text else [],
        "endpoint_env": {
            "base_url": ENV_LOCAL_BASE if effective_route == ExecutionRoute.LOCAL_ONLY else ENV_CLOUD_BASE,
            "api_key": ENV_LOCAL_KEY if effective_route == ExecutionRoute.LOCAL_ONLY else ENV_CLOUD_KEY,
            "model": ENV_LOCAL_MODEL if effective_route == ExecutionRoute.LOCAL_ONLY else ENV_CLOUD_MODEL,
        },
    }
    return payload


def render_payload(payload: Dict[str, Any], pretty: bool = False) -> str:
    """One-line (or indented) JSON text; stdout-safe for the launcher to parse."""
    return json.dumps(payload, ensure_ascii=False, sort_keys=pretty, indent=2 if pretty else None)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m engine.dsh_payload",
                                     description="Print the DSH customization payload as JSON.")
    parser.add_argument("--prompt", default="", help="Prompt to classify (optional).")
    parser.add_argument("--route", default=None, choices=[r.value for r in ExecutionRoute])
    parser.add_argument("--tier", default=None, help="LocalExecutionTier value or alias (optional).")
    parser.add_argument("--consent", action="store_true", help="Deprecated route mapper: zdr_cloud.")
    parser.add_argument("--json-pretty", action="store_true", help="Indent the JSON output.")
    args = parser.parse_args(argv)
    if args.route is not None and args.consent:
        parser.error("--route and --consent are mutually exclusive")
    payload = build_customization_payload(
        prompt=args.prompt,
        route=args.route,
        hardware_tier=args.tier,
        privacy_consent=args.consent,
    )
    sys.stdout.write(render_payload(payload, pretty=args.json_pretty) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
