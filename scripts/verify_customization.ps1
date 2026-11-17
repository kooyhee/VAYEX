<#
.SYNOPSIS
    Verifies the customization layer without needing DeepSeek Harness installed.

.DESCRIPTION
    Checks that this project is still a truthful, self-consistent customization
    layer. Every check is either exact (byte/equality) or structural; nothing here
    claims that `dsh` accepted the patch - that needs a runtime, see
    scripts\launch.ps1 and README.md.

    Checks:
      1. pyproject.toml [project].version == engine.registry.CURATED_APP_RELEASE_VERSION
      2. pyproject.toml declares no Python runtime dependencies and no entry points
         (the app that runs is `dsh`, not a Python module of ours)
      3. packaging\customization\catalog.json regenerates byte-identically from
         engine\registry.py (it is generated data, so drift is a defect)
      4. the Cordis patch template renders with the expected 8/10-space nesting and
         no leftover __PLACEHOLDER__ token
      5. engine\ and prototype\ import nothing outside the standard library
         (psutil stays a guarded, unbundled probe)
      6. THIRD_PARTY_NOTICES.md names the runtime and its licence
      7. packaging\customization\runtime.json agrees with
         pyproject.toml [tool.harness.dsh] verified_against and package

    Exit codes: 0 = every check passed, 1 = a check failed. A nonzero Python probe
    exit is always a failure, even when it printed no PROBLEM: line.

.PARAMETER Python
    Interpreter used for the Python-side checks. Defaults to "python".
#>
[CmdletBinding()]
param(
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$failures = New-Object 'System.Collections.Generic.List[string]'

function Write-Check([string]$Name, [bool]$Passed, [string]$Detail = "") {
    $tag = if ($Passed) { "pass" } else { "FAIL" }
    Write-Host ("  [{0}] {1}{2}" -f $tag, $Name, $(if ($Detail) { " - $Detail" } else { "" }))
}

function ConvertTo-YamlScalar([string]$Value) {
    # Mirrors scripts\launch.ps1: a substituted value is always a single-quoted
    # scalar, with internal single quotes doubled.
    return "'" + $Value.Replace("'", "''") + "'"
}

function Set-TemplateToken([string]$Text, [string]$Token, [string]$Value) {
    $text = $Text.Replace("'$Token'", $Token).Replace('"' + $Token + '"', $Token)
    return $text.Replace($Token, (ConvertTo-YamlScalar $Value))
}

function Get-ScalarValue([string[]]$Lines, [string]$Key) {
    # Returns the scalar a `key: value` line carries, unwrapped from single or
    # double quotes, or $null when the key is absent.
    foreach ($line in $Lines) {
        if ($line -match ('^\s*' + [regex]::Escape($Key) + ':\s*(.*)$')) {
            $value = $Matches[1].Trim()
            if ($value.Length -ge 2 -and $value.StartsWith("'") -and $value.EndsWith("'")) {
                return $value.Substring(1, $value.Length - 2).Replace("''", "'")
            }
            if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
                return $value.Substring(1, $value.Length - 2)
            }
            return $value
        }
    }
    return $null
}

Write-Host "DeepSeek Harness customization - verification" -ForegroundColor Green
Write-Host "  project : $projectRoot"

$probe = @'
import ast, json, os, pathlib, re, sys, tomllib

root = pathlib.Path(sys.argv[1])
problems = []


def read(path):
    return (root / path).read_text(encoding="utf-8")


# 1. version consistency ----------------------------------------------------
project = tomllib.loads(read("pyproject.toml"))["project"]
registry = ast.parse(read("engine/registry.py"))
engine_version = ""
for node in registry.body:
    if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
        if any(isinstance(t, ast.Name) and t.id == "CURATED_APP_RELEASE_VERSION" for t in node.targets):
            engine_version = node.value.value
print("version=%s engine=%s" % (project.get("version", ""), engine_version))
if project.get("version") != engine_version:
    problems.append("version mismatch: pyproject %r vs engine %r" % (project.get("version"), engine_version))

# 2. no python runtime deps, no python entry points -------------------------
deps = project.get("dependencies") or []
if deps:
    problems.append("pyproject declares runtime dependencies: %r" % (deps,))
for table in ("scripts", "gui-scripts"):
    if project.get(table):
        problems.append("pyproject declares [project.%s]: the runtime is dsh, not a Python entry point" % table)

# 3. catalog regenerates identically ---------------------------------------
sys.path.insert(0, str(root))
from engine.registry import ModelIntelligenceRegistry, PRIMARY_MODEL_ID, VALID_ROLES  # noqa: E402

registry_obj = ModelIntelligenceRegistry()
expected = {
    "release_version": engine_version,
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
        for entry in registry_obj.catalog
    ],
}
actual = json.loads(read("packaging/customization/catalog.json"))
if actual != expected:
    drifted = [key for key in expected if actual.get(key) != expected[key]]
    problems.append("catalog.json is stale (differs in: %s)" % ", ".join(drifted or ["<unexpected keys>"]))
print("catalog_models=%d" % len(expected["models"]))

# 5. standard library only --------------------------------------------------
local = {"engine", "harness", "prototype", "main", "demo_runner", "hardware", "cost_tracker"}
allowed_optional = {"psutil"}
guarded_depth = 0
for package in ("engine", "prototype", "harness"):
    for path in sorted((root / package).rglob("*.py")):
        name = path.name
        if name == "test_engine.py" or name == "tests_stub.py" or name.startswith("test_") or name.endswith("_test.py"):
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))

        class Collector(ast.NodeVisitor):
            def __init__(self):
                self.depth = 0
                self.found = []

            def _record(self, module, node):
                top = (module or "").split(".")[0]
                if not top or top == "__future__":
                    return
                if top in sys.stdlib_module_names or top in local:
                    return
                self.found.append((top, node.lineno, self.depth > 0))

            def visit_Import(self, node):
                for alias in node.names:
                    self._record(alias.name, node)
                self.generic_visit(node)

            def visit_ImportFrom(self, node):
                if node.level == 0:
                    self._record(node.module, node)
                self.generic_visit(node)

            def _try(self, node):
                guarded = any(
                    (h.type is None)
                    or (isinstance(h.type, ast.Name) and h.type.id in {"Exception", "ImportError", "ModuleNotFoundError"})
                    for h in node.handlers
                )
                if guarded:
                    self.depth += 1
                try:
                    for child in node.body:
                        self.visit(child)
                finally:
                    if guarded:
                        self.depth -= 1
                for child in list(node.orelse) + list(node.finalbody):
                    self.visit(child)
                for handler in node.handlers:
                    self.visit(handler)

            visit_Try = _try
            visit_TryStar = _try

        collector = Collector()
        collector.visit(tree)
        for top, lineno, guarded in collector.found:
            rel = path.relative_to(root).as_posix()
            if not (guarded and top in allowed_optional):
                problems.append("third-party import %s at %s:%d" % (top, rel, lineno))
            else:
                print("optional_probe=%s:%d" % (rel, lineno))

# 6. licence attribution ----------------------------------------------------
notices = read("packaging/customization/THIRD_PARTY_NOTICES.md")
for token in ("@deepseek-ai/dsh", "MIT", "deepseek-ai/deepseek-harness"):
    if token not in notices:
        problems.append("THIRD_PARTY_NOTICES.md does not mention %r" % token)

# 7. the runtime pin is one number, stated twice, in agreement --------------
dsh_meta = tomllib.loads(read("pyproject.toml")).get("tool", {}).get("harness", {}).get("dsh", {})
pin = json.loads(read("packaging/customization/runtime.json"))
print("pin=%s verified_against=%s" % (pin.get("version", ""), dsh_meta.get("verified_against", "")))
if pin.get("version") != dsh_meta.get("verified_against"):
    problems.append(
        "runtime pin mismatch: runtime.json %r vs pyproject verified_against %r"
        % (pin.get("version"), dsh_meta.get("verified_against"))
    )
if pin.get("package") != dsh_meta.get("package"):
    problems.append(
        "runtime package mismatch: runtime.json %r vs pyproject %r"
        % (pin.get("package"), dsh_meta.get("package"))
    )
if not pin.get("version"):
    problems.append("runtime.json does not pin a version")

# 8. the scripts take the pin from that file instead of restating it ---------
for script in ("scripts/launch.ps1", "scripts/install.ps1"):
    script_text = read(script)
    if "runtime.json" not in script_text:
        problems.append("%s does not read packaging/customization/runtime.json" % script)
    hardcoded = sorted(set(re.findall(r"@deepseek-ai/dsh@\d[0-9A-Za-z.\-]*", script_text)))
    if hardcoded:
        problems.append("%s hardcodes the runtime version: %s" % (script, ", ".join(hardcoded)))

for problem in problems:
    print("PROBLEM: " + problem)
raise SystemExit(1 if problems else 0)
'@

$probePath = Join-Path $env:TEMP ("harness-verify-" + [guid]::NewGuid().ToString("N") + ".py")
Set-Content -LiteralPath $probePath -Value $probe -Encoding UTF8
try {
    $output = & $Python $probePath $projectRoot 2>&1
    $pythonExit = $LASTEXITCODE
}
finally {
    Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
}
$problemLines = @($output | Where-Object { $_ -match '^PROBLEM: ' })

Write-Host ""
Write-Host "Python-side checks"
$detailLines = @($output | Where-Object { $_ -match '^(version=|catalog_models=|optional_probe=|pin=)' })
foreach ($line in $detailLines) { Write-Host "  $line" }
$probeDetail = ($problemLines -join "; ")
if ($pythonExit -ne 0) {
    # A crashing or erroring probe is a failure even when it printed no PROBLEM:
    # line, so the exit code alone must be able to fail the run.
    $probeDetail = @(@($probeDetail, "probe exited $pythonExit") | Where-Object { $_ }) -join "; "
    $failures.Add("the Python probe exited $pythonExit")
}
Write-Check "version, dependencies, entry points, catalog, stdlib imports, notices, runtime pin" ($pythonExit -eq 0) $probeDetail
foreach ($problem in $problemLines) { $failures.Add(($problem -replace '^PROBLEM:\s*', '')) }

# 4. patch template renders structurally ------------------------------------
Write-Host ""
Write-Host "Patch template"
$templatePath = Join-Path $projectRoot "packaging\customization\cordis.patch.template.yml"
if (-not (Test-Path -LiteralPath $templatePath)) {
    Write-Check "template exists" $false $templatePath
    $failures.Add("missing patch template: $templatePath")
}
else {
    $template = Get-Content -LiteralPath $templatePath -Raw
    $sampleEndpoint = "http://127.0.0.1:1/v1"
    $sampleModel = "render-check-model"
    # Render exactly as scripts\launch.ps1 does, so a value it would write is the
    # value checked here: every substituted value is a single-quoted YAML scalar.
    $modelItem = "          - id: " + (ConvertTo-YamlScalar $sampleModel)
    $modelsBlock = @("        models:", $modelItem) -join "`r`n"
    $rendered = $template.Replace("__MODELS__", $modelsBlock)
    $rendered = Set-TemplateToken -Text $rendered -Token "__BASE_URL__" -Value $sampleEndpoint
    $rendered = Set-TemplateToken -Text $rendered -Token "__RELEASE__" -Value "0.0.0"
    $rendered = Set-TemplateToken -Text $rendered -Token "__PRIMARY__" -Value $sampleModel

    $placeholderLeft = [regex]::Matches($rendered, '__[A-Z_]+__')
    Write-Check "no __PLACEHOLDER__ token left" ($placeholderLeft.Count -eq 0) (($placeholderLeft | ForEach-Object { $_.Value }) -join ", ")

    $lines = $rendered -split "`r?`n"
    $entryOk = $lines -contains "- id: llm-pi-ai"
    $providerOk = $lines -contains "      harness-gateway:"
    $apiOk = $lines -contains "        api: openai-completions"
    $baseUrlOk = $lines -contains ("        baseURL: " + (ConvertTo-YamlScalar $sampleEndpoint))
    $keyRefOk = $lines -contains "        apiKeyEnv: HARNESS_LLM_API_KEY"
    $modelsOk = $lines -contains "        models:"
    $modelIdOk = $lines -contains $modelItem
    $defaultModelOk = $lines -contains ("    model: " + (ConvertTo-YamlScalar $sampleModel))
    Write-Check "entry list shape (- id: llm-pi-ai)" $entryOk
    Write-Check "provider nesting (6 >= 8 spaces)" ($providerOk -and $apiOk -and $baseUrlOk -and $keyRefOk)
    Write-Check "models list nesting (8 >= 10 spaces)" ($modelsOk -and $modelIdOk)
    Write-Check "default-model row nested and quoted" $defaultModelOk
    foreach ($check in @(
        @{ Name = "entry list shape"; Ok = $entryOk },
        @{ Name = "provider nesting"; Ok = ($providerOk -and $apiOk -and $baseUrlOk -and $keyRefOk) },
        @{ Name = "models list nesting"; Ok = ($modelsOk -and $modelIdOk) },
        @{ Name = "default-model row"; Ok = $defaultModelOk },
        @{ Name = "no placeholder left"; Ok = ($placeholderLeft.Count -eq 0) }
    )) {
        if (-not $check.Ok) { $failures.Add("patch template: " + $check.Name) }
    }

    # A substituted value must be a quoted scalar; unquoted interpolation of a
    # URL or model id is what lets a value break out of its YAML position. The
    # entry-list ids (`- id: llm-pi-ai`) are literal template text, not values.
    $unquoted = @($lines | Where-Object {
        $_ -match '^\s*(baseURL|model):\s*[^\s''"#]' -or $_ -match '^ {10}- id:\s*[^\s''"#]'
    })
    Write-Check "substituted values are quoted scalars" ($unquoted.Count -eq 0) (($unquoted | ForEach-Object { $_.Trim() }) -join " | ")
    if ($unquoted.Count -gt 0) {
        $failures.Add("patch template leaves substituted values without YAML quoting")
    }

    $secretish = [regex]::Matches($rendered, '(?i)(api[_-]?key|token|secret)\s*[:=]\s*(?!HARNESS_LLM_API_KEY)\S')
    Write-Check "no literal secret in the rendered patch" ($secretish.Count -eq 0)
    if ($secretish.Count -gt 0) { $failures.Add("patch template appears to embed a secret") }

    $renderedPath = Join-Path $env:TEMP ("harness-patch-" + [guid]::NewGuid().ToString("N") + ".yml")
    Set-Content -LiteralPath $renderedPath -Value $rendered -Encoding UTF8
    Write-Host "  rendered sample: $renderedPath"
    Remove-Item -LiteralPath $renderedPath -Force -ErrorAction SilentlyContinue
}

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host ("!" * 78) -ForegroundColor Red
    Write-Host "VERIFICATION FAILED" -ForegroundColor Red
    Write-Host ("!" * 78) -ForegroundColor Red
    foreach ($failure in $failures) { Write-Host "  - $failure" -ForegroundColor Red }
    Write-Host ""
    exit 1
}
Write-Host "VERIFICATION PASSED" -ForegroundColor Green
Write-Host "  Note: this proves the layer is self-consistent. It does NOT prove dsh"
Write-Host "  accepted the patch; that requires an installed runtime."
Write-Host ""
exit 0
