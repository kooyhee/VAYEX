"""OpenAI 호환 스트리밍 LLM 클라이언트 (표준 라이브러리 전용).

설계 원칙:
- **설정은 오직 환경변수에서 온다.** ``HARNESS_LLM_BASE_URL``, ``HARNESS_LLM_API_KEY``,
  ``HARNESS_LLM_MODEL``, ``HARNESS_LLM_ROUTE``, (선택) ``HARNESS_LOCAL_BASE_URL``.
  엔드포인트가 없으면 ``ProviderNotConfiguredError``로 즉시 실패한다(추정치 대체 금지).
- **API 키는 절대 로그/예외 메시지/객체 표현에 포함되지 않는다** (``__repr__`` 마스킹).
- **비용은 공급자 보고 사용량만으로 계산한다.** ``usage``를 받지 못하면 ``None``(unknown)이며
  0으로 위장하지 않는다. 단가는 ``registry.PricingInfo.attempt_cost_usd``만 사용한다.

프로토콜: ``POST {base}/chat/completions`` + ``stream: true`` +
``stream_options: {"include_usage": true}`` → SSE ``data:`` 프레임을 ``[DONE]``까지 파싱.
"""
from __future__ import annotations

import json
import os
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Mapping, Optional, Sequence

from .registry import ModelIntelligenceRegistry

__all__ = [
    "LmClientError",
    "ProviderNotConfiguredError",
    "AuthError",
    "RateLimitError",
    "ProviderUnavailable",
    "BadRequest",
    "Usage",
    "LmClient",
    "ENV_BASE_URL",
    "ENV_API_KEY",
    "ENV_MODEL",
    "ENV_ROUTE",
    "ENV_LOCAL_BASE_URL",
]

ENV_BASE_URL = "HARNESS_LLM_BASE_URL"
ENV_API_KEY = "HARNESS_LLM_API_KEY"
ENV_MODEL = "HARNESS_LLM_MODEL"
ENV_ROUTE = "HARNESS_LLM_ROUTE"
ENV_LOCAL_BASE_URL = "HARNESS_LOCAL_BASE_URL"

_HTTP_AUTH_CODES = (401, 403)


class LmClientError(RuntimeError):
    """LLM 호출 계층 예외의 공통 상위 타입."""


class ProviderNotConfiguredError(LmClientError):
    """엔드포인트/키/모델 설정이 없어 호출 자체가 불가능할 때."""


class AuthError(LmClientError):
    """401/403 — 자격증명이 거부되었다."""


class RateLimitError(LmClientError):
    """429 — 공급자 요청 한도 초과."""


class ProviderUnavailable(LmClientError):
    """5xx/네트워크/타임아웃 — 공급자에 도달할 수 없거나 일시 장애."""


class BadRequest(LmClientError):
    """4xx — 요청 형식/모델명이 공급자 계약과 맞지 않는다."""


@dataclass(frozen=True)
class Usage:
    """공급자가 보고한 단일 호출 사용량과 그에 대응하는 비용.

    ``cost_usd``는 ``PricingInfo.attempt_cost_usd``로 계산되며, 모델 단가를 알 수 없으면
    ``None``이다(0으로 위장하지 않는다).
    """
    input_tokens: int
    output_tokens: int
    cached_tokens: int = 0
    cost_usd: Optional[float] = None
    model_id: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cached_tokens": self.cached_tokens,
            "cost_usd": self.cost_usd,
            "model_id": self.model_id,
        }


def _snippet(text: str, limit: int = 300) -> str:
    compact = " ".join((text or "").split())
    return compact[:limit]


class LmClient:
    """OpenAI 호환 ``/chat/completions`` 스트리밍 클라이언트.

    ``chat_stream``은 토큰 문자열 이터레이터를 돌려주며, 소비가 끝난 뒤 ``client.usage``에
    마지막 호출의 :class:`Usage`가 남는다(사용량 미보고 시 ``None``).
    """

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str],
        model: str,
        registry: Optional[ModelIntelligenceRegistry] = None,
        route: str = "zdr_cloud",
        timeout: float = 60.0,
        local_base_url: Optional[str] = None,
    ):
        from urllib.parse import urlsplit
        self.base_url = (base_url or "").strip().rstrip("/")
        for endpoint in (self.base_url, local_base_url or ""):
            parts = urlsplit(endpoint)
            if parts.username or parts.password or parts.query or parts.fragment:
                raise BadRequest("endpoint URL must not contain credentials, query, or fragment")
        self.model = (model or "").strip()
        self.registry = registry
        self.route = (route or "zdr_cloud").strip()
        self.timeout = float(timeout)
        self.local_base_url = (local_base_url or "").strip().rstrip("/")
        self.usage: Optional[Usage] = None
        self.last_request_model = ""
        self.last_route = self.route
        self._api_key = (api_key or "").strip()

    # ------------------------------------------------------------------ #
    # Representation / config
    # ------------------------------------------------------------------ #
    def __repr__(self) -> str:  # pragma: no cover - 표현 자체가 유일한 목적
        return (
            f"LmClient(base_url={self.base_url!r}, model={self.model!r}, "
            f"route={self.route!r}, api_key=<redacted>)"
        )

    @property
    def has_credentials(self) -> bool:
        """API 키 보유 여부(키 값 자체는 절대 노출하지 않는다)."""
        return bool(self._api_key)

    @classmethod
    def from_env(
        cls,
        model: Optional[str] = None,
        registry: Optional[ModelIntelligenceRegistry] = None,
        route: Optional[str] = None,
        timeout: float = 60.0,
    ) -> "LmClient":
        """환경변수만으로 클라이언트를 구성한다. 미설정 시 ``ProviderNotConfiguredError``."""
        env_route = (route or os.environ.get(ENV_ROUTE) or "zdr_cloud").strip()
        cloud_base = (os.environ.get(ENV_BASE_URL) or "").strip()
        local_base = (os.environ.get(ENV_LOCAL_BASE_URL) or "").strip()
        if env_route not in ("local_only", "zdr_cloud", "any_cloud"):
            raise BadRequest("invalid execution route")
        if env_route == "local_only":
            base = local_base or cloud_base
        else:
            base = cloud_base
        if not base:
            raise ProviderNotConfiguredError(
                f"no LLM endpoint configured: set {ENV_BASE_URL}"
                + (f" (or {ENV_LOCAL_BASE_URL} for local_only)" if env_route == "local_only" else "")
            )
        api_key = (os.environ.get(ENV_API_KEY) or "").strip()
        if not api_key and env_route != "local_only":
            raise ProviderNotConfiguredError(f"no API key configured: set {ENV_API_KEY}")
        chosen_model = (model or os.environ.get(ENV_MODEL) or "").strip()
        return cls(
            base_url=base,
            api_key=api_key,
            model=chosen_model,
            registry=registry,
            route=env_route,
            timeout=timeout,
            local_base_url=local_base,
        )

    # ------------------------------------------------------------------ #
    # HTTP plumbing
    # ------------------------------------------------------------------ #
    @property
    def cost_usd(self) -> Optional[float]:
        return self.usage.cost_usd if self.usage is not None else None

    def _url(self, path: str) -> str:
        from urllib.parse import urlsplit
        base = (self.local_base_url or self.base_url) if self.last_route == "local_only" else self.base_url
        if not base:
            raise ProviderNotConfiguredError(f"{ENV_BASE_URL} is empty; refusing to guess an endpoint")
        parts = urlsplit(base)
        if (parts.scheme not in ("http", "https") or not parts.hostname
                or parts.username or parts.password or parts.query or parts.fragment):
            raise BadRequest("endpoint must be an HTTP(S) base URL without credentials or query")
        if self.last_route == "local_only" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise BadRequest("local_only requires a loopback endpoint")
        return f"{base}/{path.lstrip('/')}"

    def _open(
        self,
        method: str,
        path: str,
        payload: Optional[Mapping[str, Any]] = None,
        timeout: Optional[float] = None,
        stream: bool = False,
    ):
        url = self._url(path)
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if stream else "application/json",
            "User-Agent": "deepseek-harness-engine/1.0",
        }
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        wait = self.timeout if timeout is None else float(timeout)
        # An SSLContext must not be handed to a plain-HTTP opener on every platform build.
        tls = ssl.create_default_context() if url.startswith("https://") else None
        try:
            return urllib.request.urlopen(request, timeout=wait, context=tls)
        except urllib.error.HTTPError as exc:
            try:
                exc.read()
            except Exception:  # noqa: BLE001
                pass
            finally:
                exc.close()
            raise self._map_http_error(exc.code, url) from None
        except urllib.error.URLError as exc:
            raise ProviderUnavailable("cannot reach configured provider") from None
        except TimeoutError:
            raise ProviderUnavailable(f"request to {url} timed out after {wait}s") from None
        except OSError as exc:
            raise ProviderUnavailable(f"network failure talking to {url}: {exc}") from None

    @staticmethod
    def _map_http_error(code: int, url: str) -> LmClientError:
        if code in _HTTP_AUTH_CODES:
            return AuthError(f"authentication rejected by {url} ({code})")
        if code == 429:
            return RateLimitError(f"rate limited by {url} (429)")
        if 400 <= code < 500:
            return BadRequest(f"request rejected by {url} ({code})")
        return ProviderUnavailable(f"provider error from {url} ({code})")

    @classmethod
    def _map_stream_error(cls, payload: Mapping[str, Any]) -> LmClientError:
        raw_code = payload.get("code", payload.get("status"))
        detail = "provider reported a streaming error"
        try:
            code = int(raw_code)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            code = 0
        if code in _HTTP_AUTH_CODES:
            return AuthError(f"authentication rejected mid-stream: {detail}")
        if code == 429:
            return RateLimitError(f"rate limited mid-stream: {detail}")
        if 400 <= code < 500:
            return BadRequest(f"request rejected mid-stream: {detail}")
        return ProviderUnavailable(f"provider error mid-stream: {detail}")

    # ------------------------------------------------------------------ #
    # Streaming
    # ------------------------------------------------------------------ #
    def chat_stream(
        self,
        messages: Sequence[Mapping[str, Any]],
        model: Optional[str] = None,
        route: str = "zdr_cloud",
        timeout: float = 60,
    ) -> Iterator[str]:
        """토큰 델타 이터레이터를 반환한다. 소비 후 ``self.usage``가 채워진다."""
        chosen_model = (model or self.model or "").strip()
        if not chosen_model:
            raise ProviderNotConfiguredError(
                f"no model configured: pass a model or set {ENV_MODEL}"
            )
        if not isinstance(messages, Sequence) or isinstance(messages, (str, bytes)) or not messages:
            raise BadRequest("messages must be a non-empty sequence of chat messages")
        self.usage = None
        self.last_request_model = chosen_model
        self.last_route = (route or self.route or "zdr_cloud").strip()
        return self._iter_stream(list(messages), chosen_model, timeout)

    def _iter_stream(
        self,
        messages: List[Mapping[str, Any]],
        model: str,
        timeout: float,
    ) -> Iterator[str]:
        payload = {
            "model": model,
            "messages": messages,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if self.last_route not in ("local_only", "zdr_cloud", "any_cloud"):
            raise BadRequest("invalid execution route")
        response = self._open("POST", "/chat/completions", payload, timeout=timeout, stream=True)
        response_model = model
        try:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
                if not line or line.startswith(":"):
                    continue
                if not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                if not data:
                    continue
                if data == "[DONE]":
                    return
                try:
                    event = json.loads(data)
                except json.JSONDecodeError as exc:
                    raise ProviderUnavailable(f"malformed SSE data frame: {exc}") from None
                if not isinstance(event, dict):
                    raise ProviderUnavailable("malformed SSE data frame: payload is not an object")
                error_payload = event.get("error")
                if error_payload:
                    if isinstance(error_payload, Mapping):
                        raise self._map_stream_error(error_payload)
                    raise ProviderUnavailable("provider reported a streaming error")
                if event.get("model"):
                    response_model = str(event["model"])
                for choice in event.get("choices") or ():
                    if not isinstance(choice, Mapping):
                        continue
                    delta = choice.get("delta")
                    if not isinstance(delta, Mapping):
                        continue
                    piece = delta.get("content")
                    if isinstance(piece, str) and piece:
                        yield piece
                usage_payload = event.get("usage")
                if isinstance(usage_payload, Mapping):
                    self.usage = self._build_usage(usage_payload, response_model)
            raise ProviderUnavailable("SSE stream ended before [DONE]")
        except (OSError, TimeoutError):
            raise ProviderUnavailable("network failure while reading SSE stream") from None
        finally:
            try:
                response.close()
            except Exception:  # noqa: BLE001 - 종료 경로는 조용히 닫는다
                pass

    # ------------------------------------------------------------------ #
    # Usage / pricing
    # ------------------------------------------------------------------ #
    def _build_usage(self, payload: Mapping[str, Any], model_id: str) -> Optional[Usage]:
        prompt_tokens = payload.get("prompt_tokens", payload.get("input_tokens", None))
        completion_tokens = payload.get("completion_tokens", payload.get("output_tokens", None))
        if prompt_tokens is None or completion_tokens is None:
            # Partial usage cannot be priced without inventing the missing count.
            return None
        details = payload.get("prompt_tokens_details")
        cached_raw = None
        if isinstance(details, Mapping):
            cached_raw = details.get("cached_tokens")
        if cached_raw is None:
            cached_raw = payload.get("cache_read_input_tokens", payload.get("cached_tokens"))
        try:
            input_tokens = int(prompt_tokens)
            output_tokens = int(completion_tokens)
            cached_tokens = int(cached_raw or 0)
        except (TypeError, ValueError):
            return None
        if input_tokens < 0 or output_tokens < 0 or not 0 <= cached_tokens <= input_tokens:
            return None
        return Usage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_tokens=cached_tokens,
            cost_usd=self._price(model_id, input_tokens, output_tokens, cached_tokens),
            model_id=model_id,
        )

    def _price(
        self,
        model_id: str,
        input_tokens: int,
        output_tokens: int,
        cached_tokens: int,
    ) -> Optional[float]:
        """레지스트리 단가로 계산한 비용. 모델 단가를 모르면 ``None``."""
        registry = self.registry
        if registry is None:
            registry = ModelIntelligenceRegistry()
            self.registry = registry
        try:
            entry = registry.get_model(model_id)
        except KeyError:
            return None
        ratio = (cached_tokens / input_tokens) if input_tokens > 0 else 0.0
        return entry.pricing.attempt_cost_usd(input_tokens, output_tokens, ratio)

    # ------------------------------------------------------------------ #
    # Health check
    # ------------------------------------------------------------------ #
    def health_check(self, timeout: Optional[float] = None) -> List[str]:
        """``GET {base}/models``로 공급자가 보고하는 모델 ID 목록을 반환한다."""
        response = self._open("GET", "/models", None, timeout=timeout, stream=False)
        try:
            raw = response.read().decode("utf-8", errors="replace")
        finally:
            try:
                response.close()
            except Exception:  # noqa: BLE001
                pass
        try:
            payload = json.loads(raw or "{}")
        except json.JSONDecodeError as exc:
            raise ProviderUnavailable(f"model list response was not JSON: {exc}") from None
        if not isinstance(payload, Mapping):
            raise ProviderUnavailable("model list response was not a JSON object")
        reported: List[str] = []
        data = payload.get("data")
        if isinstance(data, Sequence) and not isinstance(data, (str, bytes)):
            for item in data:
                if isinstance(item, Mapping) and item.get("id"):
                    reported.append(str(item["id"]))
        if not reported:
            models = payload.get("models")
            if isinstance(models, Sequence) and not isinstance(models, (str, bytes)):
                for item in models:
                    if isinstance(item, Mapping) and item.get("id"):
                        reported.append(str(item["id"]))
                    elif isinstance(item, str):
                        reported.append(item)
        if not reported:
            raise ProviderUnavailable("model list response did not report any model ids")
        return reported
