"""Regenerate ``packaging/customization/catalog.json`` from ``engine/registry.py``.

The catalog is generated data: the engine's curated preset registry is the source
of truth for release version, primary model, valid roles and every model record.
``scripts/verify_customization.ps1`` rebuilds the same structure and fails when
the committed file differs, so this script is the only supported way to change
the catalog. Never hand-edit the JSON.

Usage (from ``40_AI보고서``)::

    python packaging/customization/generate_catalog.py

The rendered text is validated before the file is opened for writing, so a
registry that produces an unusable catalog fails the run without touching the
committed file.

Exit codes: 0 = written, 1 = validation failed (file untouched) or the bytes
written did not read back identically.
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CATALOG_PATH = pathlib.Path(__file__).resolve().with_name("catalog.json")
TOP_LEVEL_KEYS = ("release_version", "primary_model", "valid_roles", "source", "models")
MODEL_KEYS = ("id", "display_name", "provider", "roles", "context_window", "zero_data_retention")

sys.path.insert(0, str(ROOT))

from engine.registry import (  # noqa: E402
    CURATED_APP_RELEASE_VERSION,
    PRIMARY_MODEL_ID,
    VALID_ROLES,
    ModelIntelligenceRegistry,
)


def build_catalog() -> dict:
    registry = ModelIntelligenceRegistry()
    return {
        "release_version": CURATED_APP_RELEASE_VERSION,
        "primary_model": PRIMARY_MODEL_ID,
        "valid_roles": sorted(VALID_ROLES),
        "source": "engine/registry.py (generated; do not hand-edit)",
        "models": [
            {
                "id": entry.model_id,
                "display_name": entry.display_name,
                "provider": entry.provider,
                "roles": list(entry.roles),
                "context_window": entry.context_window,
                "zero_data_retention": entry.privacy.zero_data_retention,
            }
            for entry in registry.catalog
        ],
    }


def render(catalog: dict) -> str:
    # CRLF and a trailing newline: the committed file keeps the repository's
    # line endings so a regeneration is byte-identical.
    return json.dumps(catalog, indent=2, ensure_ascii=False) + "\n"


def validate(text: str, catalog: dict) -> list:
    """Check the rendered bytes against the shape the verifier compares.

    Runs before anything is written: an empty or malformed registry must fail
    here, not after ``catalog.json`` has already been overwritten.
    """
    problems = []
    try:
        parsed = json.loads(text)
    except ValueError as error:
        return ["rendered catalog is not valid JSON: %s" % error]
    if parsed != catalog:
        problems.append("rendered text does not round-trip to the built catalog")
    if tuple(parsed) != TOP_LEVEL_KEYS:
        return problems + ["top-level keys are %r, expected %r" % (tuple(parsed), TOP_LEVEL_KEYS)]
    if parsed["release_version"] != CURATED_APP_RELEASE_VERSION:
        problems.append("release_version %r is not the registry version" % (parsed["release_version"],))
    if not parsed["models"]:
        problems.append("catalog has no models")
    seen = set()
    for entry in parsed["models"]:
        if tuple(entry) != MODEL_KEYS:
            problems.append("model record keys are %r, expected %r" % (tuple(entry), MODEL_KEYS))
            continue
        model_id = entry["id"]
        if not isinstance(model_id, str) or not model_id:
            problems.append("model id is not a non-empty string: %r" % (model_id,))
        elif model_id in seen:
            problems.append("duplicate model id: %s" % model_id)
        seen.add(model_id)
        unknown_roles = sorted(set(entry["roles"]) - VALID_ROLES)
        if unknown_roles:
            problems.append("%s declares roles outside VALID_ROLES: %s" % (model_id, ", ".join(unknown_roles)))
        if not isinstance(entry["context_window"], int) or entry["context_window"] <= 0:
            problems.append("%s has a non-positive context_window: %r" % (model_id, entry["context_window"]))
        if not isinstance(entry["zero_data_retention"], bool):
            problems.append("%s has a non-boolean zero_data_retention" % model_id)
    if parsed["primary_model"] not in seen:
        problems.append("primary_model %r is not in the catalog" % (parsed["primary_model"],))
    return problems


def main() -> int:
    catalog = build_catalog()
    text = render(catalog)
    problems = validate(text, catalog)
    if problems:
        for problem in problems:
            print("catalog not written: " + problem, file=sys.stderr)
        return 1
    with CATALOG_PATH.open("w", encoding="utf-8", newline="\r\n") as handle:
        handle.write(text)
    written = CATALOG_PATH.read_text(encoding="utf-8")
    if written != text:
        print("catalog write read back differently: %s" % CATALOG_PATH.name, file=sys.stderr)
        return 1
    print("wrote %s (%d models)" % (CATALOG_PATH, len(catalog["models"])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
