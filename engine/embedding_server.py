"""로컬 임베딩 서버 (표준 라이브러리 전용, 새 의존성 없음).

목적: 장기 메모리 검색과 외부 모델 조사에서 **유료 임베딩 API 호출 없이** 동작하도록
OpenAI 호환 ``POST /v1/embeddings`` 를 제공한다. HTTP 계층은 ``http.server`` 와 ``json``
만 쓰며 서드파티 패키지를 가져오지 않는다.

엔드포인트:
- ``POST /v1/embeddings`` — ``{"model": str, "input": str | list[str]}`` 를 받아
  ``{"object": "list", "data": [{"object": "embedding", "index": i, "embedding": [...]}],
  "model": ..., "usage": {"prompt_tokens": n, "total_tokens": n}}`` 를 돌려준다.
  기존 OpenAI 호환 클라이언트가 shim 없이 가리킬 수 있는 최소 형태다.
- ``GET /v1/models`` — 제공 모델 1건과 백엔드 공개 정보.
- ``GET /healthz`` — 준비 상태, 활성 백엔드, 합성 여부, 한도, 인증 없음 고지.
- ``GET /stats`` — 요청 수/텍스트 수/실패 수/토큰 근사치/수신 바이트.

진실성 계약:
- ``/healthz`` 와 ``/v1/models`` 는 활성 백엔드, 모델 ID, 차원, 그리고 출력이
  **합성(synthetic)** 인지 항상 밝힌다. 공개 값은 ``true`` / ``false`` / ``unknown``
  세 가지이며, 어느 백엔드도 상위(upstream)의 공개를 더 강한 주장으로 승격하지 않는다.
- :class:`HashBackend` 는 토큰 해시 기반 결정론적 의사 벡터이며 **의미 임베딩이 아니다**.
  유사도 품질을 주장하지 않는다(배선/테스트/통합 전용).
- :class:`LocalModelBackend` 는 로컬 가중치가 설정되지 않았거나 로더가 없으면 조용히
  대체하지 않고 :class:`LocalModelUnavailableError` 로 실패한다. 적재된 모델이 없는
  상태를 적재된 것처럼 보이게 하지 않는다. 로더가 돌려준 런타임은 ``synthetic`` 과
  ``billing_known`` 을 **스스로 선언**해야 하고, 선언이 없거나 과금을 알 수 없거나
  원격 백엔드(:class:`RemoteBackend`)이면 거부한다(래퍼의 라벨을 신뢰하지 않는다).
- :class:`RemoteBackend` 는 루프백 전용이며 원격 과금을 알 수 없으므로 응답을 무료로
  표시하지 않는다(``X-Embedding-Free: false``, ``X-Embedding-Cost-USD: unknown``).
  합성 여부는 상위 응답의 ``X-Embedding-Synthetic`` 공개 헤더에서만 가져오며, 헤더가
  없으면 ``unknown`` 이다(비합성으로 간주하지 않는다).
- 로컬 백엔드의 비용은 구성상 0 이다(계산이 이 기기에서 일어난다). 그 응답에는 항상
  ``X-Embedding-Cost-USD: 0`` 이 붙는다.

보안/운영:
- 기본 바인드는 ``127.0.0.1`` 이다. 루프백이 아닌 주소는 명시적
  ``allow_non_loopback=True``(CLI ``--allow-non-loopback``) 없이는 거부하고, 허용하면
  "장치 외부에 노출된다"는 경고를 로그로 남긴다. 이 가드는 ``EmbeddingHTTPServer``
  생성자 안에 있으므로 어떤 생성 경로도 우회할 수 없다. 환경변수만으로는 허용되지
  않는다(명시적 플래그 전용).
- 호스트명(``localhost`` 등)은 문자열 분류로 신뢰하지 않고 직접 해석한 뒤 **모든** 해석
  주소가 루프백인지 확인하고, 검증된 주소로 바인드를 고정한다. 해석이 비루프백 주소를
  돌려주면 거부한다(DNS/호스트 설정이 연결 경계를 바꾸지 못하게 한다).
- 인증 계층은 만들지 않는다(인증 연극 금지). 이 엔드포인트는 **인증 없는 로컬
  엔드포인트**이며, 포트에 닿을 수 있는 누구나 호출할 수 있다. 외부 노출이 필요하면
  인증/방화벽은 이 프로세스 바깥의 몫이다.
- 요청 본문 크기, 배치 텍스트 수, 원격 응답 크기를 모두 상한으로 자른다. 본문이나 벡터를
  캐시하지 않으므로 메모리가 무한히 자라지 않는다.
- **읽기 시간 상한**: 연결마다 소켓 타임아웃(``socket_timeout_seconds``, 기본 10초)과
  단계별 전체 읽기 예산(``max_read_seconds``, 기본 20초)을 둔다. 요청 라인+헤더 단계와
  본문 단계는 각각 자기 예산을 가지며, 수신할 때마다 ``settimeout(min(남은 예산,
  socket_timeout))`` 로 소켓 타임아웃을 다시 걸고 **한 번에 한 ``recv``** 만 한다. 버퍼
  파일 객체의 ``read(n)`` 처럼 n 바이트를 채우려고 내부에서 여러 번 ``recv`` 하는 호출은
  쓰지 않는다(비활동 창 직전 간격으로 한 바이트씩 보내는 클라이언트가 한 호출 안에서 예산을
  무한정 늘리던 우회를 막는다). 예산이 바닥나면 명시적 :class:`RequestTimeoutError` →
  408 ``request_timeout`` 이고, 0/음수 타임아웃(비블로킹)은 절대 걸지 않는다.
- **주소 패밀리 일치**: 해석된 루프백 주소의 패밀리(``AF_INET``/``AF_INET6``)로 서버의
  ``address_family`` 를 맞춘 뒤 바인드한다. ``::1`` 이나 IPv6 우선 ``localhost`` 도 그대로
  동작하고, 이 호스트가 그 패밀리로 소켓을 만들 수 없으면 ``bind`` 의 막연한 ``OSError``
  대신 주소 패밀리를 밝힌 명시적 거부로 실패한다. 루프백 전용 보장은 그대로다.
- **요청별 공개**: ``/v1/embeddings`` 응답의 ``X-Embedding-Synthetic`` 값은 **그 요청**의
  백엔드 결과(:attr:`EmbeddingBatchResult.synthetic`)가 들고 온다. 원격 백엔드는 요청 사이에
  공개 상태를 공유하지 않으므로, 동시 요청이 서로의 공개값으로 잘못 표시되지 않는다.
- ``/healthz`` 의 ``bind.loopback`` 분류는 **DNS 를 쓰지 않는다**(바인드 주소는 언제나 해석된
  루프백 리터럴이므로 리터럴 분류로 충분하다). health 경로가 이름 해석에 의존하지 않는다.
- **상한 초과 본문은 즉시 거부**한다: ``Content-Length`` 가 한도를 넘으면 본문을 버리려고
  읽지 않고 바로 400 ``request_too_large`` 로 응답한 뒤 연결을 닫는다(드레인 대기 없음).
- **동시 처리 상한**: 핸들러 스레드는 ``max_concurrent_requests``(기본 8)로 제한하며,
  초과분은 대기시키지 않고 즉시 503 ``too_many_concurrent_requests`` 로 응답한다.
- ``usage.prompt_tokens`` 는 모델 토크나이저가 아니라 어휘 토큰 세기(근사치)다
  (``X-Embedding-Token-Count: lexical-approximation`` 헤더로 알린다).
"""
from __future__ import annotations

import argparse
import errno
import hashlib
import io
import json
import logging
import math
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import ip_address
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Protocol, Sequence, Tuple
from urllib.parse import urlsplit

__all__ = [
    "EmbeddingBackend",
    "EmbeddingBatchResult",
    "HashBackend",
    "LocalModelBackend",
    "RemoteBackend",
    "EmbeddingHTTPServer",
    "EmbeddingServerError",
    "BackendError",
    "BackendResponseError",
    "RemoteBackendError",
    "NonLoopbackEndpointError",
    "NonLoopbackBindError",
    "BindAddressFamilyError",
    "LocalModelUnavailableError",
    "MalformedRequestError",
    "RequestTimeoutError",
    "ModelNotServedError",
    "UnknownRouteError",
    "MethodNotAllowedError",
    "create_server",
    "select_backend",
    "describe_backend",
    "describe_cost",
    "resolve_loopback_address",
    "count_lexical_tokens",
    "is_loopback_host",
    "is_loopback_literal",
    "main",
    "DEFAULT_HOST",
    "DEFAULT_PORT",
    "DEFAULT_DIMENSIONS",
    "DEFAULT_MAX_BODY_BYTES",
    "DEFAULT_MAX_BATCH_TEXTS",
    "DEFAULT_MAX_CONCURRENT_REQUESTS",
    "DEFAULT_SOCKET_TIMEOUT_SECONDS",
    "DEFAULT_MAX_READ_SECONDS",
    "HASH_MODEL_ID",
    "LOCAL_MODEL_ID",
    "ENV_REMOTE_URL",
    "ENV_LOCAL_WEIGHTS",
]

LOGGER = logging.getLogger(__name__)

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8099
DEFAULT_DIMENSIONS = 256
DEFAULT_MAX_BODY_BYTES = 1 << 20  # 1 MiB
DEFAULT_MAX_BATCH_TEXTS = 64
DEFAULT_MAX_CONCURRENT_REQUESTS = 8  # 동시 핸들러 스레드 상한(초과분은 즉시 503)
DEFAULT_SOCKET_TIMEOUT_SECONDS = 10.0  # 연결별 소켓 읽기/쓰기 타임아웃
DEFAULT_MAX_READ_SECONDS = 20.0  # 요청 본문 전체를 읽는 데 허용하는 총 시간
MAX_REMOTE_RESPONSE_BYTES = 8 << 20  # 8 MiB, 원격 응답 상한
POST_RESPONSE_DRAIN_BYTES = 64 << 10  # 오류 응답 뒤 버리는 미수신 요청 바이트 상한
POST_RESPONSE_DRAIN_SECONDS = 0.25  # 그 정리에 허용하는 최대 시간(응답 지연 아님)
_READ_CHUNK_BYTES = 65536
_MAX_REQUEST_HEAD_BYTES = 64 << 10  # 요청 라인+헤더 상한(초과분은 400 으로 거부)
_USE_BACKEND_DISCLOSURE = object()  # _send_json: "요청별 값이 없으면 백엔드 공개값" 표식

HASH_MODEL_ID = "local/hash-embedding-v1"
LOCAL_MODEL_ID = "local/embedding-placeholder-v1"

ENV_REMOTE_URL = "HARNESS_EMBEDDING_REMOTE_URL"
ENV_LOCAL_WEIGHTS = "HARNESS_EMBEDDING_WEIGHTS"

# fts5_memory 의 어휘 토크나이저와 같은 문자 집합을 쓴다(모델 토크나이저가 아니다).
_LEXICAL_TOKEN = re.compile(r"[A-Za-z0-9_가-힣]+")
_LOOPBACK_HOSTNAMES = frozenset({"localhost", "localhost.localdomain", "ip6-localhost"})
_ROUTES = {
    "/v1/embeddings": "POST",
    "/v1/models": "GET",
    "/healthz": "GET",
    "/stats": "GET",
}


# --------------------------------------------------------------------------- #
# 예외
# --------------------------------------------------------------------------- #
class EmbeddingServerError(Exception):
    """임베딩 서버 계층 예외의 공통 상위 타입."""


class BackendError(EmbeddingServerError):
    """백엔드가 계약대로 벡터를 만들 수 없을 때(설정 누락/응답 형식 위반)."""


class BackendResponseError(BackendError):
    """백엔드가 형식이 잘못된 벡터를 돌려주었을 때."""


class RemoteBackendError(BackendError):
    """루프백 원격 엔드포인트에 도달하지 못했거나 응답이 계약과 다를 때."""


class NonLoopbackEndpointError(BackendError):
    """루프백이 아닌 주소를 원격 엔드포인트로 쓰려 했을 때."""


class LocalModelUnavailableError(BackendError):
    """로컬 임베딩 가중치/로더가 없어 모델 경로를 쓸 수 없을 때(대체 금지)."""


class MalformedRequestError(EmbeddingServerError):
    """요청 형식 위반 → 400. ``code`` 로 세부 사유를 알린다."""

    code = "invalid_request"

    def __init__(self, message: str, code: Optional[str] = None,
                 param: Optional[str] = None) -> None:
        super().__init__(message)
        if code:
            self.code = code
        self.param = param


class ModelNotServedError(EmbeddingServerError):
    """이 서버가 모르는 ``model`` → 404 (이름을 그대로 밝힌다)."""


class UnknownRouteError(EmbeddingServerError):
    """정의되지 않은 경로 → 404."""


class MethodNotAllowedError(EmbeddingServerError):
    """경로는 있으나 메서드 불일치 → 405."""


class NonLoopbackBindError(EmbeddingServerError):
    """명시적 허용 없이 루프백이 아닌 주소에 바인드하려 할 때."""


class BindAddressFamilyError(EmbeddingServerError):
    """해석된 루프백 주소의 패밀리로 이 호스트에서 소켓을 만들 수 없을 때.

    ``bind`` 가 던지는 막연한 ``OSError`` 대신 어떤 주소 패밀리가 문제인지 밝힌다
    (예: IPv6 를 끈 호스트에서 ``::1`` 에 바인드하려는 경우).
    """


class RequestTimeoutError(EmbeddingServerError):
    """요청 본문을 정해진 시간 안에 다 읽지 못했을 때 → 408."""


# --------------------------------------------------------------------------- #
# 공용 헬퍼
# --------------------------------------------------------------------------- #
def _literal_address(value: str) -> Optional[Any]:
    try:
        return ip_address(value)
    except ValueError:
        return None


def _address_family(literal: Any) -> int:
    """검증된 IP 리터럴의 소켓 주소 패밀리(IPv4/IPv6)."""
    return socket.AF_INET6 if literal.version == 6 else socket.AF_INET


def _family_name(family: int) -> str:
    return {socket.AF_INET: "AF_INET (IPv4)", socket.AF_INET6: "AF_INET6 (IPv6)"}.get(
        family, str(family)
    )


def is_loopback_literal(host: str) -> bool:
    """**해석 없이** 문자열 리터럴만으로 루프백인지 판정한다(DNS 조회 없음).

    ``/healthz`` 처럼 매 요청 도는 경로에서 쓴다. 호스트명은 여기서 True 가 될 수 없다
    (해석이 필요한 이름은 이 함수의 대상이 아니다).
    """
    address = _literal_address((host or "").strip().strip("[]").split("%")[0])
    return address is not None and address.is_loopback


def resolve_loopback_address(host: str, what: str) -> str:
    """루프백 주소를 **해석해서** 돌려준다(호스트명은 해석 결과 전부가 루프백이어야 한다).

    ``localhost`` 같은 이름을 문자열로만 믿으면 호스트 파일/DNS 가 비루프백 주소를 돌려줄 때
    연결 경계가 그 주소로 넘어간다. 그래서 여기서 직접 해석해 모든 해석 결과가 루프백인지
    확인하고 첫 번째 루프백 주소를 돌려준다(호출자가 이 주소로 바인드/연결을 고정한다).
    루프백 이름이 아닌 호스트명은 해석조차 하지 않고 거부한다(불필요한 DNS 조회 없음).
    """
    value = (host or "").strip().strip("[]").lower()
    if not value:
        raise NonLoopbackEndpointError(
            f"{what} must be a loopback address; refusing an empty host. "
            "Use 127.0.0.1, ::1 or localhost."
        )
    literal = _literal_address(value)
    if literal is not None:
        if literal.is_loopback:
            return str(literal)
        raise NonLoopbackEndpointError(
            f"{what} must stay on a loopback address; refusing {host!r}. "
            "Use 127.0.0.1, ::1 or localhost."
        )
    if value not in _LOOPBACK_HOSTNAMES:
        raise NonLoopbackEndpointError(
            f"{what} must be a loopback literal or one of "
            f"{', '.join(sorted(_LOOPBACK_HOSTNAMES))}; refusing hostname {host!r} "
            "(it is never resolved, so it cannot be trusted to stay on-device)."
        )
    try:
        infos = socket.getaddrinfo(value, None, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise NonLoopbackEndpointError(
            f"{what}: cannot resolve loopback hostname {host!r}: {exc}"
        ) from None
    resolved: List[str] = []
    for info in infos:
        raw = str(info[4][0]).split("%")[0]
        address = _literal_address(raw)
        if address is None or not address.is_loopback:
            raise NonLoopbackEndpointError(
                f"{what}: {host!r} resolved to non-loopback address {raw}; refusing. "
                "Pin the loopback literal (127.0.0.1 or ::1) instead."
            )
        resolved.append(raw)
    if not resolved:
        raise NonLoopbackEndpointError(
            f"{what}: loopback hostname {host!r} resolved to no address"
        )
    return resolved[0]


def is_loopback_host(host: str) -> bool:
    """루프백 판정 공개 헬퍼. 호스트명은 해석 결과가 전부 루프백일 때만 True."""
    try:
        resolve_loopback_address(host, "host")
    except NonLoopbackEndpointError:
        return False
    return True


def count_lexical_tokens(text: str) -> int:
    """``usage`` 블록용 어휘 토큰 수(근사치). 모델 토크나이저 수가 아니다."""
    return len(_LEXICAL_TOKEN.findall(text or ""))


# --------------------------------------------------------------------------- #
# 백엔드 계약
# --------------------------------------------------------------------------- #
class EmbeddingBatchResult:
    """한 번의 ``embed_batch`` 호출 결과 — 벡터와 **그 요청**의 합성 공개.

    공개값(``synthetic``)을 벡터와 함께 돌려주므로 응답 작성자가 백엔드의 공유 상태를 읽지
    않는다. 그래야 동시 요청이 서로의 공개값(예: 다른 요청의 ``false``)으로 잘못 표시되지
    않는다. ``synthetic`` 은 ``True``/``False``, 공개가 없으면 ``None``(미상)이다.
    """

    __slots__ = ("vectors", "synthetic")

    def __init__(self, vectors: List[List[float]],
                 synthetic: Optional[bool] = None) -> None:
        self.vectors = vectors
        self.synthetic = synthetic if isinstance(synthetic, bool) else None

    def __repr__(self) -> str:  # pragma: no cover - 진단용
        return (f"EmbeddingBatchResult(vectors={len(self.vectors)}, "
                f"synthetic={self.synthetic!r})")


class EmbeddingBackend(Protocol):
    """임베딩 백엔드 계약.

    ``model_id`` 는 ``/v1/models`` 가 광고하는 이름이고, ``dimensions`` 는 벡터 폭이다
    (``RemoteBackend`` 는 첫 호출 전까지 ``None`` 일 수 있다). ``synthetic`` 은 출력이
    의미 임베딩이 아님을 밝히는 **백엔드 수준** 공개값이며 ``True`` / ``False`` / ``None``
    (미상) 중 하나다. 요청별 공개는 넘어오지 않으므로 ``embed_batch`` 결과가 함께 돌려준다.
    ``billing_known`` 은 비용을 0 으로 단정할 수 있는지를 뜻하고, 미선언(``None``)은 미상이다.
    """

    model_id: str
    dimensions: Optional[int]
    synthetic: Optional[bool]
    billing_known: Optional[bool]

    def embed_batch(self, texts: Sequence[str]) -> EmbeddingBatchResult:
        """텍스트 시퀀스를 같은 순서의 벡터 + 그 요청의 공개값으로 바꾼다."""


class HashBackend:
    """토큰 해시 기반 결정론적 의사 임베딩.

    **경고: 의미 임베딩이 아니다.** 토큰을 블레이크2로 해시해 고정 차원 버킷에 부호와 함께
    누적한 뒤 L2 정규화한다. 같은 텍스트는 언제나 같은 벡터이고 차원도 일정하지만, 벡터
    사이의 거리는 어휘 겹침만 반영하므로 의미 유사도를 주장하지 않는다. 모델 다운로드, GPU,
    네트워크 없이 서버/테스트/통합을 돌리기 위한 자리표시자다.
    """

    synthetic = True
    billing_known = True

    def __init__(self, dimensions: int = DEFAULT_DIMENSIONS,
                 model_id: str = HASH_MODEL_ID) -> None:
        if not isinstance(dimensions, int) or dimensions < 8:
            raise ValueError("dimensions must be an integer >= 8")
        self.dimensions = dimensions
        self.model_id = model_id

    def embed_text(self, text: str) -> List[float]:
        vector = [0.0] * self.dimensions
        for token in _LEXICAL_TOKEN.findall((text or "").lower()):
            digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
            bucket = int.from_bytes(digest[:4], "big") % self.dimensions
            vector[bucket] += 1.0 if digest[4] & 1 else -1.0
        norm = math.sqrt(sum(value * value for value in vector))
        if norm == 0.0:
            return vector
        return [value / norm for value in vector]

    def embed_batch(self, texts: Sequence[str]) -> EmbeddingBatchResult:
        return EmbeddingBatchResult([self.embed_text(text) for text in texts], self.synthetic)


def _declared_bool(obj: Any, attribute: str) -> Optional[bool]:
    """객체가 ``bool`` 로 직접 선언한 플래그를 읽는다(없거나 bool 이 아니면 예외)."""
    value = getattr(obj, attribute, None)
    if not isinstance(value, bool):
        raise LocalModelUnavailableError(
            f"local embedding runtime must declare {attribute} as a bool (got {value!r}); "
            "this server will not infer synthetic/billing status on a runtime's behalf"
        )
    return value


class LocalModelBackend:
    """로컬 가중치 백엔드 자리표시자 — 설정이 없으면 크게 실패한다.

    이 서버는 모델 런타임을 내장하지 않고 가중치를 내려받지도 않는다. ``weights_path`` 와
    호출 가능한 ``loader`` 가 모두 준비된 경우에만 로더가 돌려준 객체(``embed_batch`` 와
    선택적 ``dimensions`` 를 가진)로 실제 추론을 위임한다. 그 밖의 경우에는
    :class:`LocalModelUnavailableError` 를 던지며, 절대 가짜 벡터로 대체하지 않는다.

    이 백엔드의 ``synthetic``/``billing_known`` 은 **래퍼의 상수가 아니라 적재된 런타임의
    선언**에서 온다. 런타임은 두 값을 ``bool`` 로 직접 선언해야 하며, 과금을 알 수 없는
    런타임(``billing_known`` 이 ``True`` 가 아님)이나 :class:`RemoteBackend` 를 돌려주는
    로더는 거부한다. 즉 원격 미상 과금 출력을 "로컬 · 0원"으로 승격하는 경로가 없다.
    """

    def __init__(self, model_id: str = LOCAL_MODEL_ID,
                 weights_path: Optional[str] = None,
                 dimensions: Optional[int] = None,
                 loader: Optional[Any] = None) -> None:
        self.model_id = model_id
        self.weights_path = (str(weights_path).strip() if weights_path else "") or None
        self._dimensions = dimensions
        self._loader = loader
        self._runtime: Optional[Any] = None

    @property
    def loaded(self) -> bool:
        return self._runtime is not None

    @property
    def synthetic(self) -> Optional[bool]:
        """적재된 런타임이 선언한 합성 여부. 적재 전에는 ``None``(미상)이다."""
        if self._runtime is None:
            return None
        return _declared_bool(self._runtime, "synthetic")

    @property
    def billing_known(self) -> bool:
        """런타임이 ``billing_known=True`` 를 선언했을 때만 참(추정으로 0원을 만들지 않음)."""
        if self._runtime is None:
            return False
        return _declared_bool(self._runtime, "billing_known") is True

    @property
    def dimensions(self) -> int:
        if self._dimensions is not None:
            return self._dimensions
        runtime = self._ensure_runtime()
        width = getattr(runtime, "dimensions", None)
        if not isinstance(width, int) or width < 1:
            raise LocalModelUnavailableError(
                "local embedding loader returned no usable 'dimensions'; "
                "pass dimensions=... or make the loader expose an integer 'dimensions'"
            )
        self._dimensions = width
        return width

    def _missing_weights_message(self) -> str:
        return (
            "no local embedding weights are configured: pass --local-weights PATH or set "
            f"{ENV_LOCAL_WEIGHTS} to a local weights file, then provide a loader this server "
            "can call. This server never downloads weights and never fakes a loaded model; "
            "use --backend hash for the synthetic (non-semantic) placeholder."
        )

    def _ensure_runtime(self) -> Any:
        if self._runtime is not None:
            return self._runtime
        if not self.weights_path:
            raise LocalModelUnavailableError(self._missing_weights_message())
        if not Path(self.weights_path).is_file():
            raise LocalModelUnavailableError(
                f"local embedding weights not found at {self.weights_path}: check "
                f"--local-weights / {ENV_LOCAL_WEIGHTS}. Nothing was downloaded."
            )
        if self._loader is None:
            raise LocalModelUnavailableError(
                f"weights at {self.weights_path} exist but no loader is installed, so no model "
                "runtime can run them; pass loader=<callable(weights_path) -> object with "
                "embed_batch>, or use --backend hash for the synthetic (non-semantic) "
                "placeholder. This server never downloads a runtime."
            )
        try:
            runtime = self._loader(self.weights_path)
        except LocalModelUnavailableError:
            raise
        except Exception as exc:  # noqa: BLE001 - 로더 예외는 설정 오류로 보고한다
            raise LocalModelUnavailableError(
                f"local embedding loader failed for {self.weights_path}: {exc}"
            ) from exc
        if isinstance(runtime, RemoteBackend):
            raise LocalModelUnavailableError(
                "local embedding loader returned a RemoteBackend; a local model backend must "
                "not wrap a remote forwarder (its billing is unknown and its vectors are not "
                "computed on this device)"
            )
        if not callable(getattr(runtime, "embed_batch", None)):
            raise LocalModelUnavailableError(
                "local embedding loader must return an object exposing embed_batch(texts)"
            )
        # 런타임이 스스로 선언하지 않은 합성/과금 정보를 래퍼가 추정하지 않는다.
        if _declared_bool(runtime, "billing_known") is not True:
            raise LocalModelUnavailableError(
                "local embedding loader returned a runtime whose billing is unknown "
                "(billing_known != True); this server only reports zero cost when the runtime "
                "declares on-device billing, so the loader is refused"
            )
        _declared_bool(runtime, "synthetic")
        self._runtime = runtime
        return runtime

    def embed_batch(self, texts: Sequence[str]) -> EmbeddingBatchResult:
        runtime = self._ensure_runtime()
        vectors = [[float(value) for value in vector]
                   for vector in runtime.embed_batch(list(texts))]
        # 이 백엔드는 공유 런타임 상태를 갖지 않으므로 요청 시점의 선언을 그대로 돌려준다.
        return EmbeddingBatchResult(vectors, self.synthetic)


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """리다이렉트를 따라가지 않는다(로컬 엔드포인트가 다른 주소로 유도하는 것을 거부)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401 - 표준 시그니처
        LOGGER.warning("refusing redirect (%s) from local embedding endpoint to %s", code, newurl)
        return None


class RemoteBackend:
    """이미 동작 중인 **루프백** OpenAI 호환 임베딩 엔드포인트로 전달한다.

    ``base_url`` 은 API 루트(예: ``http://127.0.0.1:9000/v1``)이고 ``{base_url}/embeddings`` 로
    POST 한다. 루프백이 아닌 주소는 생성 시점에 거부하며, 호스트명은 해석해서 나온 루프백
    주소로 **고정**한다(해석 결과가 비루프백이면 거부). 리다이렉트는 따라가지 않으며 프록시
    환경변수도 쓰지 않는다. 원격 과금은 이 서버가 알 수 없으므로 ``billing_known = False``
    이며 응답은 무료로 표시되지 않는다.

    합성 여부는 **상위 응답의 공개 헤더**(``X-Embedding-Synthetic``)에서만 가져오며, 그 값은
    ``embed_batch`` 결과(:class:`EmbeddingBatchResult`)에 **요청별로** 실린다. 백엔드는 공개
    상태를 요청 사이에 저장하지 않으므로, 헤더를 생략한 상위 응답과 ``false`` 를 밝힌 상위
    응답이 동시에 처리되어도 서로의 값으로 잘못 표시되지 않는다. 헤더가 없거나 해석할 수
    없으면 그 요청의 공개는 ``None``(미상)이며, 비합성이라고 주장하지 않는다.
    """

    billing_known = False
    DISCLOSURE_HEADER = "X-Embedding-Synthetic"

    def __init__(self, base_url: str, model_id: str = "", dimensions: Optional[int] = None,
                 timeout: float = 30.0) -> None:
        self.base_url = self._validate_base_url(base_url)
        self.model_id = (model_id or "").strip()
        self._dimensions = dimensions
        self.timeout = float(timeout)
        self._opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), _NoRedirectHandler()
        )

    @property
    def synthetic(self) -> Optional[bool]:
        """백엔드 수준 공개는 미상(``None``)이다 — 공개는 **요청별** 값이기 때문이다.

        이 백엔드는 어느 요청의 공개값도 보관하지 않는다(공유 상태가 곧 오표시 원인이다).
        ``/v1/embeddings`` 응답은 그 요청의 :class:`EmbeddingBatchResult` 값을 쓰고,
        ``/healthz`` 처럼 특정 요청이 없는 경로는 미상으로 남긴다.
        """
        return None

    @property
    def dimensions(self) -> Optional[int]:
        return self._dimensions

    @staticmethod
    def _validate_base_url(base_url: str) -> str:
        value = (base_url or "").strip()
        parts = urlsplit(value)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise BackendError(
                "remote embedding base URL must be an absolute http(s) URL, "
                "for example http://127.0.0.1:9000/v1"
            )
        if parts.username or parts.password or parts.query or parts.fragment:
            raise BackendError(
                "remote embedding base URL must not contain credentials, query or fragment"
            )
        pinned = resolve_loopback_address(parts.hostname, "RemoteBackend base URL")
        host = f"[{pinned}]" if ":" in pinned else pinned
        port = f":{parts.port}" if parts.port else ""
        return f"{parts.scheme}://{host}{port}{parts.path.rstrip('/')}"

    def _read_disclosure(self, headers: Any) -> Optional[bool]:
        """상위 공개 헤더만 신뢰해 **이 요청의** 공개값을 돌려준다.

        값이 없거나 이상하면 ``None``(미상)이다. 반환값은 호출자의 결과에만 실리고 백엔드
        속성에 저장되지 않는다(동시 요청 사이의 공유 없음).
        """
        raw = ""
        try:
            raw = (headers.get(self.DISCLOSURE_HEADER) or "").strip().lower()
        except AttributeError:  # 헤더 조회가 불가능한 응답 객체
            raw = ""
        if raw == "true":
            return True
        if raw == "false":
            return False
        return None

    def embed_batch(self, texts: Sequence[str]) -> EmbeddingBatchResult:
        items = list(texts)
        if not items:
            raise BackendError("embed_batch requires at least one text")
        payload = {"model": self.model_id, "input": items}
        request = urllib.request.Request(
            f"{self.base_url}/embeddings",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "local-embedding-server/1.0",
            },
            method="POST",
        )
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                disclosure = self._read_disclosure(response.headers)
                raw = response.read(MAX_REMOTE_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read(512).decode("utf-8", "replace").strip()
            except Exception:  # noqa: BLE001 - 진단용 상세는 best-effort
                detail = ""
            finally:
                exc.close()
            if 300 <= exc.code < 400:
                raise RemoteBackendError(
                    f"remote embedding endpoint at {self.base_url} attempted a redirect "
                    f"({exc.code}); redirects are refused"
                ) from None
            raise RemoteBackendError(
                f"remote embedding endpoint at {self.base_url} returned HTTP {exc.code}: "
                f"{detail or 'no detail'}"
            ) from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise RemoteBackendError(
                f"cannot reach remote embedding endpoint at {self.base_url}: {exc}"
            ) from None
        if len(raw) > MAX_REMOTE_RESPONSE_BYTES:
            raise RemoteBackendError(
                f"remote embedding response exceeded {MAX_REMOTE_RESPONSE_BYTES} bytes"
            )
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError):
            raise RemoteBackendError(
                "remote embedding endpoint returned a non-JSON body"
            ) from None
        return EmbeddingBatchResult(self._parse(body, expected=len(items)), disclosure)

    def _parse(self, body: Any, expected: int) -> List[List[float]]:
        if not isinstance(body, Mapping):
            raise RemoteBackendError("remote embedding response must be a JSON object")
        data = body.get("data")
        if not isinstance(data, list) or len(data) != expected:
            raise RemoteBackendError(
                f"remote embedding response must contain {expected} embeddings"
            )
        entries = sorted(
            data,
            key=lambda entry: entry.get("index", -1) if isinstance(entry, Mapping) else -1,
        )
        vectors: List[List[float]] = []
        for position, entry in enumerate(entries):
            if not isinstance(entry, Mapping):
                raise RemoteBackendError("remote embedding entries must be JSON objects")
            if entry.get("index") != position:
                raise RemoteBackendError(
                    "remote embedding response indexes must be 0..n-1 in order"
                )
            raw_vector = entry.get("embedding")
            if not isinstance(raw_vector, list) or not raw_vector:
                raise RemoteBackendError("remote embedding entry has no embedding vector")
            try:
                vector = [float(value) for value in raw_vector]
            except (TypeError, ValueError):
                raise RemoteBackendError(
                    "remote embedding vector contains non-numeric values"
                ) from None
            vectors.append(vector)
        width = len(vectors[0])
        if any(len(vector) != width for vector in vectors):
            raise RemoteBackendError("remote embedding response has inconsistent dimensions")
        if self._dimensions is not None and self._dimensions != width:
            raise RemoteBackendError(
                f"remote embedding width {width} does not match configured dimensions "
                f"{self._dimensions}"
            )
        self._dimensions = width
        return vectors


def _as_batch_result(value: Any, backend: EmbeddingBackend) -> EmbeddingBatchResult:
    """백엔드 반환값을 :class:`EmbeddingBatchResult` 로 정규화한다.

    이 모듈의 백엔드는 결과 객체를 돌려준다. 요청별 공개를 싣지 않는 외부/구형 백엔드가
    벡터 목록만 돌려주면 공개는 그 백엔드의 수준 값(원격이면 미상)으로 채운다 — 공유 상태를
    요청별 값처럼 승격하지는 않는다.
    """
    if isinstance(value, EmbeddingBatchResult):
        return value
    if isinstance(value, (list, tuple)):
        return EmbeddingBatchResult(list(value), getattr(backend, "synthetic", None))
    raise BackendResponseError(
        f"backend returned {type(value).__name__}, not an EmbeddingBatchResult or vector list"
    )


def select_backend(name: str, *, dimensions: Optional[int] = None, model_id: Optional[str] = None,
                   remote_url: Optional[str] = None, local_weights: Optional[str] = None,
                   loader: Optional[Any] = None) -> EmbeddingBackend:
    """백엔드 선택 지점(CLI 와 테스트가 같은 경로를 쓴다).

    ``hash`` → :class:`HashBackend` (합성, 무료), ``remote`` → :class:`RemoteBackend`
    (루프백 전용, 과금 미상), ``local`` → :class:`LocalModelBackend` (설정 없으면 실패).
    """
    choice = (name or "").strip().lower()
    if choice == "hash":
        return HashBackend(dimensions=dimensions or DEFAULT_DIMENSIONS,
                           model_id=model_id or HASH_MODEL_ID)
    if choice == "local":
        return LocalModelBackend(model_id=model_id or LOCAL_MODEL_ID,
                                 weights_path=local_weights or None,
                                 dimensions=dimensions, loader=loader)
    if choice == "remote":
        url = (remote_url or "").strip()
        if not url:
            raise BackendError(
                f"the remote backend needs a loopback base URL: pass --remote-url or set "
                f"{ENV_REMOTE_URL} (for example http://127.0.0.1:9000/v1)"
            )
        return RemoteBackend(base_url=url, model_id=model_id or "", dimensions=dimensions)
    raise BackendError(f"unknown backend {name!r}; choose from hash, remote, local")


# --------------------------------------------------------------------------- #
# 공개 정보(진실성) 헬퍼
# --------------------------------------------------------------------------- #
def describe_backend(backend: EmbeddingBackend) -> Dict[str, Any]:
    """``/healthz``, ``/v1/models`` 공용 백엔드 공개 정보(합성 여부 포함).

    ``synthetic`` 은 ``True``/``False``/``None``(미상) 세 가지다. 백엔드가 공개하지 않았으면
    ``None`` 으로 남기며, 어떤 경로도 미상을 비합성으로 승격하지 않는다.
    """
    info: Dict[str, Any] = {
        "backend": type(backend).__name__,
        "model_id": getattr(backend, "model_id", ""),
        "synthetic": None,
        "synthetic_known": False,
        "billing_known": False,
        "dimensions": None,
        "status": "ready",
        "error": None,
    }
    # 차원 조회가 로컬 런타임을 실제로 적재한다. 공개 플래그는 그 뒤에 읽어야
    # 런타임이 선언한 값을 얻는다(적재 전 추정 금지).
    try:
        info["dimensions"] = backend.dimensions
    except LocalModelUnavailableError as exc:
        info["status"] = "unavailable"
        info["error"] = str(exc)
        info["note"] = (
            "no model is loaded: the local backend cannot serve embeddings until weights and "
            "a loader are configured, and this server will not substitute synthetic vectors"
        )
        info["billing_known"] = bool(getattr(backend, "billing_known", False))
        return info

    raw_synthetic = getattr(backend, "synthetic", None)
    if not isinstance(raw_synthetic, bool):
        raw_synthetic = None
    info["synthetic"] = raw_synthetic
    info["synthetic_known"] = raw_synthetic is not None
    billing_known = bool(getattr(backend, "billing_known", False))
    info["billing_known"] = billing_known
    if isinstance(backend, HashBackend):
        info["note"] = (
            "HashBackend output is a deterministic token-hash vector, NOT semantic "
            "embeddings; no model is loaded and similarity quality is not claimed"
        )
    elif isinstance(backend, RemoteBackend):
        # 원격 공개는 **요청별** 값이다(백엔드에 공유 상태가 없다). 이 경로는 어느 요청에도
        # 속하지 않으므로 미상으로 남기고, 요청별 공개는 그 응답 헤더가 나른다.
        info["note"] = (
            "the upstream disclosure is per request, so this endpoint-level view is unknown: "
            "each POST /v1/embeddings response reports its own "
            f"{RemoteBackend.DISCLOSURE_HEADER} value (unknown when the upstream omits it). "
            "This server never claims non-synthetic on the upstream's behalf"
        )
    elif raw_synthetic is None:
        info["note"] = (
            "the local runtime is not loaded yet, so it has not declared whether its vectors "
            "are synthetic or whether billing is on-device; both stay unknown until it loads"
        )
    else:
        info["note"] = "vectors come from local weights; all compute stays on this device"
    if info["dimensions"] is None:
        info["note"] += "; dimensions are known after the first embedding call"
    return info


def describe_cost(backend: EmbeddingBackend) -> Dict[str, Any]:
    """비용 공개: 로컬 백엔드는 구성상 0, 원격/미상은 무료로 위장하지 않는다.

    ``billing_known`` 이 ``bool True`` 로 선언된 경우만 0원이며, 미선언(``None``)은 미상이다.
    """
    if getattr(backend, "billing_known", None) is True:
        return {
            "free": True,
            "billing": "free-by-construction",
            "usd_per_request": 0.0,
            "note": "computation runs on this device; every response reports zero cost",
        }
    if isinstance(backend, RemoteBackend):
        billing, note = "unknown-remote", (
            "vectors come from a remote endpoint whose billing this server cannot see; "
            "responses are not free by construction"
        )
    else:
        billing, note = "unknown-not-loaded", (
            "no runtime has declared on-device billing yet, so this server cannot claim zero "
            "cost; responses are not marked free"
        )
    return {
        "free": False,
        "billing": billing,
        "usd_per_request": None,
        "note": note,
    }


# --------------------------------------------------------------------------- #
# 통계
# --------------------------------------------------------------------------- #
_STAT_KEYS: Tuple[str, ...] = (
    "requests_total", "embedding_requests", "texts_embedded",
    "failed_requests", "tokens_counted", "bytes_received",
)


class _Stats:
    """스레드 안전 카운터. 본문/벡터는 저장하지 않는다(무한 증가 없음)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counts: Dict[str, int] = {key: 0 for key in _STAT_KEYS}

    def bump(self, **deltas: int) -> None:
        with self._lock:
            for key, delta in deltas.items():
                if key not in self._counts:
                    raise KeyError(f"unknown stat {key}")
                self._counts[key] += int(delta)

    def snapshot(self) -> Dict[str, int]:
        with self._lock:
            return dict(self._counts)


# --------------------------------------------------------------------------- #
# HTTP 계층
# --------------------------------------------------------------------------- #
class EmbeddingHTTPServer(ThreadingHTTPServer):
    """백엔드와 한도를 들고 있는 스레드 서버(데몬 스레드, 요청당 연결 1개).

    루프백 바인드 가드는 **이 생성자 안에** 있다. ``create_server()`` 나 ``main()`` 을 거치지
    않고 직접 생성해도 비루프백 주소는 명시적 ``allow_non_loopback=True`` 없이는
    :class:`NonLoopbackBindError` 이며, 허용 시에는 off-device 노출 경고를 남긴다.
    루프백 호스트명은 해석해서 나온 루프백 주소로 **고정**한다(해석이 비루프백이면 거부).
    동시 처리 스레드는 ``max_concurrent_requests`` 로 제한하며 초과분은 대기 없이 503.
    """

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address: Tuple[str, int], backend: EmbeddingBackend, *,
                 allow_non_loopback: bool = False,
                 max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
                 max_batch_texts: int = DEFAULT_MAX_BATCH_TEXTS,
                 max_concurrent_requests: int = DEFAULT_MAX_CONCURRENT_REQUESTS,
                 socket_timeout_seconds: float = DEFAULT_SOCKET_TIMEOUT_SECONDS,
                 max_read_seconds: float = DEFAULT_MAX_READ_SECONDS) -> None:
        host, port = server_address[0], int(server_address[1])
        if int(max_concurrent_requests) < 1:
            raise ValueError("max_concurrent_requests must be >= 1")
        if not float(socket_timeout_seconds) > 0 or not float(max_read_seconds) > 0:
            raise ValueError("socket_timeout_seconds and max_read_seconds must be > 0")
        if allow_non_loopback:
            bound_host = host
            try:  # 루프백 이름은 해석해서 고정한다(해석이 비루프백이면 경고 대상).
                bound_host = resolve_loopback_address(host, "bind address")
            except NonLoopbackEndpointError:
                LOGGER.warning(
                    "embedding server is binding to non-loopback address %s: the "
                    "unauthenticated endpoint is exposed off-device and anyone who can reach "
                    "the port can call it",
                    host,
                )
        else:
            try:
                bound_host = resolve_loopback_address(host, "bind address")
            except NonLoopbackEndpointError as exc:
                raise NonLoopbackBindError(
                    f"refusing to bind {host!r}: {exc} This endpoint is unauthenticated and "
                    "defaults to loopback only. Pass allow_non_loopback=True (CLI "
                    "--allow-non-loopback) to expose it off-device."
                ) from None
        self.backend = backend
        self.max_body_bytes = int(max_body_bytes)
        self.max_batch_texts = int(max_batch_texts)
        self.max_concurrent_requests = int(max_concurrent_requests)
        self.socket_timeout_seconds = float(socket_timeout_seconds)
        self.max_read_seconds = float(max_read_seconds)
        self.stats = _Stats()
        self.started_at = time.monotonic()
        self._admission = threading.BoundedSemaphore(self.max_concurrent_requests)
        # 해석된 루프백 리터럴의 패밀리를 서버 소켓 패밀리로 삼는다. 이렇게 해야 ``::1``
        # 이나 IPv6 우선 ``localhost`` 가 AF_INET 소켓에 그대로 넘어가 bind 에서 깨지지 않는다.
        literal = _literal_address(str(bound_host).split("%")[0])
        if literal is not None:
            self.address_family = _address_family(literal)
        # 루프백 전용 경로에서는 그 패밀리의 소켓을 만들 수 있는지 먼저 확인해, ``bind`` 의
        # 막연한 OSError 대신 주소 패밀리를 밝힌 오류로 실패하게 한다.
        if not allow_non_loopback:
            self._require_address_family(bound_host)
        try:
            super().__init__((bound_host, port), EmbeddingRequestHandler)
        except OSError as exc:
            if not allow_non_loopback and exc.errno in (
                    errno.EAFNOSUPPORT, errno.EADDRNOTAVAIL,
                    errno.EPROTONOSUPPORT, errno.EPFNOSUPPORT):
                raise self._family_error(bound_host, exc) from None
            raise

    def _require_address_family(self, bound_host: str) -> None:
        """바인드 전에 그 패밀리로 소켓을 만들 수 있는지 확인한다(명확한 실패)."""
        try:
            probe = socket.socket(self.address_family, socket.SOCK_STREAM)
        except OSError as exc:
            raise self._family_error(bound_host, exc) from None
        probe.close()

    def _family_error(self, bound_host: str, exc: OSError) -> BindAddressFamilyError:
        return BindAddressFamilyError(
            f"cannot bind {bound_host!r} with address family "
            f"{_family_name(self.address_family)}: this host does not support that "
            f"address family ({exc}). Pick a loopback literal of a supported family "
            "(127.0.0.1 or ::1); the loopback-only guarantee is unchanged."
        )

    def limits(self) -> Dict[str, Any]:
        return {
            "max_body_bytes": self.max_body_bytes,
            "max_batch_texts": self.max_batch_texts,
            "max_remote_response_bytes": MAX_REMOTE_RESPONSE_BYTES,
            "max_concurrent_requests": self.max_concurrent_requests,
            "socket_timeout_seconds": self.socket_timeout_seconds,
            "max_read_seconds": self.max_read_seconds,
        }

    def base_url(self) -> str:
        host, port = self.server_address[0], self.server_address[1]
        shown = f"[{host}]" if ":" in str(host) else str(host)
        return f"http://{shown}:{port}"

    # -- 동시 처리 상한 --------------------------------------------------- #
    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._admission.acquire(blocking=False):
            self._reject_busy(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._admission.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._admission.release()

    def _reject_busy(self, request: Any) -> None:
        """상한 초과 연결은 대기시키지 않고 즉시 503 으로 응답하고 닫는다."""
        self.stats.bump(requests_total=1, failed_requests=1)
        payload = json.dumps({"error": {
            "message": (
                f"too many concurrent requests: the limit is {self.max_concurrent_requests}. "
                "Retry after an in-flight request completes; requests are never queued."
            ),
            "type": "rate_limit_error",
            "code": "too_many_concurrent_requests",
        }}, ensure_ascii=False).encode("utf-8")
        try:
            request.settimeout(self.socket_timeout_seconds)
            request.sendall(
                b"HTTP/1.1 503 Service Unavailable\r\n"
                b"Content-Type: application/json; charset=utf-8\r\n"
                b"Retry-After: 1\r\n"
                + f"Content-Length: {len(payload)}\r\n".encode("ascii")
                + b"Connection: close\r\n\r\n" + payload
            )
        except OSError:  # 클라이언트가 이미 끊었다
            LOGGER.debug("cannot send 503 to a client that already disconnected")
            self.shutdown_request(request)
            return
        self.finish_connection(request)
        self.shutdown_request(request)

    def finish_connection(self, request: Any) -> None:
        """응답을 보낸 뒤 **상한이 있는** 정리: 미수신 요청 바이트를 짧게 버리고 닫는다.

        서버가 읽지 않은 요청 본문을 남긴 채 소켓을 닫으면 커널이 RST 를 보내 방금 보낸
        오류 응답이 사라질 수 있다. 그래서 쓰기 방향만 먼저 닫고(FIN), 남은 입력을
        최대 ``POST_RESPONSE_DRAIN_BYTES`` 바이트 / ``POST_RESPONSE_DRAIN_SECONDS`` 동안만
        버린다. 거부 응답은 이미 전송되었으므로 이 정리는 응답 지연이 아니라 정리일 뿐이며,
        대기 시간에는 언제나 상한이 있다(멈춘 클라이언트가 스레드를 무기한 붙잡지 못한다).
        """
        try:
            request.shutdown(socket.SHUT_WR)
        except OSError:
            return
        deadline = time.monotonic() + min(self.socket_timeout_seconds,
                                          POST_RESPONSE_DRAIN_SECONDS)
        discarded = 0
        while discarded < POST_RESPONSE_DRAIN_BYTES:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            request.settimeout(min(self.socket_timeout_seconds, left))
            try:
                chunk = request.recv(min(_READ_CHUNK_BYTES,
                                         POST_RESPONSE_DRAIN_BYTES - discarded))
            except OSError:
                break
            if not chunk:
                break
            discarded += len(chunk)


def create_server(backend: Optional[EmbeddingBackend] = None, host: str = DEFAULT_HOST,
                  port: int = DEFAULT_PORT, *, allow_non_loopback: bool = False,
                  max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
                  max_batch_texts: int = DEFAULT_MAX_BATCH_TEXTS,
                  max_concurrent_requests: int = DEFAULT_MAX_CONCURRENT_REQUESTS,
                  socket_timeout_seconds: float = DEFAULT_SOCKET_TIMEOUT_SECONDS,
                  max_read_seconds: float = DEFAULT_MAX_READ_SECONDS) -> EmbeddingHTTPServer:
    """서버를 만든다. 루프백 가드는 :class:`EmbeddingHTTPServer` 가 직접 강제한다."""
    chosen = backend if backend is not None else HashBackend()
    return EmbeddingHTTPServer(
        (host, port), chosen,
        allow_non_loopback=allow_non_loopback,
        max_body_bytes=max_body_bytes,
        max_batch_texts=max_batch_texts,
        max_concurrent_requests=max_concurrent_requests,
        socket_timeout_seconds=socket_timeout_seconds,
        max_read_seconds=max_read_seconds,
    )


def classify_error(exc: Exception) -> Tuple[int, str, str]:
    """예외 → (HTTP 상태, OpenAI 스타일 ``type``, ``code``)."""
    if isinstance(exc, MalformedRequestError):
        return 400, "invalid_request_error", exc.code
    if isinstance(exc, RequestTimeoutError):
        return 408, "invalid_request_error", "request_timeout"
    if isinstance(exc, ModelNotServedError):
        return 404, "not_found_error", "model_not_found"
    if isinstance(exc, UnknownRouteError):
        return 404, "not_found_error", "unknown_path"
    if isinstance(exc, MethodNotAllowedError):
        return 405, "invalid_request_error", "method_not_allowed"
    if isinstance(exc, LocalModelUnavailableError):
        return 503, "backend_unavailable", "local_model_unavailable"
    if isinstance(exc, RemoteBackendError):
        return 502, "backend_error", "remote_backend_error"
    if isinstance(exc, BackendResponseError):
        return 502, "backend_error", "backend_response_invalid"
    if isinstance(exc, BackendError):
        return 502, "backend_error", "backend_error"
    return 500, "server_error", "internal_error"


class EmbeddingRequestHandler(BaseHTTPRequestHandler):
    """OpenAI 호환 임베딩 라우터. 인증 없음 — 로컬 전용을 전제한다."""

    protocol_version = "HTTP/1.1"
    server_version = "local-embedding-server/1.0"
    server: EmbeddingHTTPServer

    def setup(self) -> None:
        """연결 소켓에 기본 타임아웃을 건다(요청 라인조차 보내지 않는 클라이언트 방어)."""
        super().setup()
        self.connection.settimeout(self.server.socket_timeout_seconds)
        self._body_consumed = True
        self._disclosure: Any = _USE_BACKEND_DISCLOSURE
        self._pending_body = b""

    # -- 요청 라인/헤더 예산 --------------------------------------------- #
    def handle_one_request(self) -> None:  # noqa: D401 - 표준 훅 재정의
        """요청 라인+헤더 전체에도 **집계** 예산을 준다(비활동 창만으로는 부족하다).

        표준 구현은 ``self.rfile.readline(...)`` 과 ``parse_headers(self.rfile)`` 로 버퍼
        파일 객체를 쓰는데, 그 내부 ``recv`` 들에는 우리 예산이 걸리지 않는다(한 호출이
        여러 번 ``recv`` 하므로). 그래서 머리말은 소켓에서 직접 한 번에 한 ``recv`` 씩,
        매번 ``settimeout(min(남은 예산, socket_timeout))`` 으로 읽어 ``max_read_seconds``
        안에 끝낸다. 예산이 바닥나면 명시적 408 이다.
        """
        self.raw_requestline = b""
        self.requestline = ""
        self.command = self.path = self.request_version = ""
        self._disclosure: Any = _USE_BACKEND_DISCLOSURE
        self._pending_body = b""
        try:
            head = self._read_head(_MAX_REQUEST_HEAD_BYTES, "request line and headers")
            if not head:
                self.close_connection = True
                return
            requestline, separator, rest = head.partition(b"\r\n")
            self.raw_requestline = requestline + separator
            header_block, terminator, body_start = rest.partition(b"\r\n\r\n")
            # 같은 recv 로 이미 도착한 본문 바이트를 버리지 않는다(다음 단계가 먼저 쓴다).
            self._pending_body = body_start if terminator else b""
            saved_rfile = self.rfile
            # parse_request() 는 헤더를 self.rfile 에서 읽는다. 이미 예산 안에서 읽어 둔
            # 바이트만 그 파일 객체로 보여 주고(소켓에서 다시 읽지 않는다), 끝나면 되돌린다.
            self.rfile = io.BytesIO(header_block + b"\r\n\r\n")
            try:
                parsed = self.parse_request()
            finally:
                self.rfile = saved_rfile
            if not parsed:
                return
            self._disclosure = _USE_BACKEND_DISCLOSURE
            method = getattr(self, "do_" + self.command, None)
            if method is None:
                self.send_error(HTTPStatus.NOT_IMPLEMENTED,
                                "Unsupported method (%r)" % self.command)
                return
            method()
            self.wfile.flush()
        except RequestTimeoutError as exc:
            # 머리말 도중 끊겼다: 읽지 않은 요청 바이트가 남았을 수 있으므로 상한 있는 정리.
            self._body_consumed = False
            self._send_error(exc)
        except (TimeoutError, OSError) as exc:
            LOGGER.debug("connection closed while reading the request head: %s", exc)
            self.close_connection = True

    def _remaining_budget(self, deadline: float, what: str) -> float:
        left = deadline - time.monotonic()
        if left <= 0:
            raise RequestTimeoutError(
                f"{what} timed out: the {self.server.max_read_seconds}s read budget is "
                "exhausted; the connection is closed. Send the request faster or raise "
                "--max-read-seconds."
            )
        return left

    def _recv_with_budget(self, max_bytes: int, deadline: float, what: str) -> bytes:
        """남은 예산과 비활동 창 중 **작은** 값을 걸고 소켓에서 **한 번만** recv 한다.

        버퍼 파일 객체의 ``read(n)`` 은 n 바이트를 채우려고 내부에서 여러 번 ``recv`` 하므로
        비활동 창 직전 간격으로 한 바이트씩 보내는 클라이언트가 한 호출 안에서 예산을
        무한정 늘릴 수 있었다. 여기서는 남은 예산으로 매 수신마다 타임아웃을 다시 걸고
        한 번만 읽으므로 그 우회가 성립하지 않는다. 0/음수 타임아웃(=비블로킹)은 절대
        걸지 않는다(``BlockingIOError`` 가 가짜 타임아웃으로 새어 나온다).
        """
        timeout = min(self.server.socket_timeout_seconds,
                      self._remaining_budget(deadline, what))
        self.connection.settimeout(max(timeout, 1e-3))
        try:
            chunk = self.connection.recv(max_bytes)
        except socket.timeout:
            raise RequestTimeoutError(
                f"{what} timed out: no data arrived within "
                f"{max(timeout, 1e-3):.3f}s and the "
                f"{self.server.max_read_seconds}s read budget is spent; the connection "
                "is closed."
            ) from None
        except OSError as exc:
            raise RequestTimeoutError(
                f"{what} timed out: the socket failed inside the "
                f"{self.server.max_read_seconds}s read budget ({exc}); the connection "
                "is closed."
            ) from None
        return chunk

    def _read_head(self, max_bytes: int, what: str) -> bytes:
        """요청 라인+머리말을 **자기 집계 예산** 안에서 소켓에서 직접 읽는다."""
        deadline = time.monotonic() + self.server.max_read_seconds
        buffer = bytearray()
        while b"\r\n\r\n" not in buffer:
            if len(buffer) > max_bytes:
                raise MalformedRequestError(
                    f"{what} exceeded {max_bytes} bytes; the connection is closed.",
                    code="request_head_too_large",
                )
            chunk = self._recv_with_budget(
                min(_READ_CHUNK_BYTES, max_bytes + 1 - len(buffer)), deadline, what)
            if not chunk:
                break
            buffer.extend(chunk)
        return bytes(buffer)

    # -- 라우팅 ---------------------------------------------------------- #
    def do_GET(self) -> None:  # noqa: N802 - 표준 훅 이름
        self._safe_dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._safe_dispatch("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self._deny_method()

    def do_PATCH(self) -> None:  # noqa: N802
        self._deny_method()

    def do_DELETE(self) -> None:  # noqa: N802
        self._deny_method()

    def _deny_method(self) -> None:
        self.server.stats.bump(requests_total=1, failed_requests=1)
        self._send_json(405, {"error": {
            "message": f"method {self.command} is not supported; available paths: "
                       + ", ".join(f"{method} {path}" for path, method in _ROUTES.items()),
            "type": "invalid_request_error",
            "code": "method_not_allowed",
        }})

    def _safe_dispatch(self, method: str) -> None:
        self.server.stats.bump(requests_total=1)
        try:
            path = urlsplit(self.path).path or "/"
            allowed = _ROUTES.get(path)
            if allowed is None:
                raise UnknownRouteError(
                    f"unknown path {path!r}; available: "
                    + ", ".join(f"{m} {p}" for p, m in _ROUTES.items())
                )
            if method != allowed:
                raise MethodNotAllowedError(f"{path} accepts {allowed} only")
            handler = getattr(self, "_handle_" + path.strip("/").replace("/", "_"))
            handler()
        except EmbeddingServerError as exc:
            self.server.stats.bump(failed_requests=1)
            self._send_error(exc)
        except Exception:  # noqa: BLE001 - 마지막 방어선: 프로세스를 죽이지 않는다
            LOGGER.exception("unhandled error while serving %s %s", method, self.path)
            self.server.stats.bump(failed_requests=1)
            self._send_json(500, {"error": {
                "message": "internal server error",
                "type": "server_error",
                "code": "internal_error",
            }})

    # -- 엔드포인트 ------------------------------------------------------ #
    def _handle_v1_embeddings(self) -> None:
        raw = self._read_body()
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError) as exc:
            raise MalformedRequestError(
                f"request body must be parseable UTF-8 JSON: {exc}", code="invalid_json"
            ) from None
        if not isinstance(payload, dict):
            raise MalformedRequestError("request body must be a JSON object")

        model = payload.get("model")
        if not isinstance(model, str) or not model.strip():
            raise MalformedRequestError("'model' must be a non-empty string", param="model")
        model = model.strip()
        texts = self._validate_input(payload.get("input"))
        served = self.server.backend.model_id
        if model != served:
            raise ModelNotServedError(
                f"model {model!r} is not served by this endpoint; available model: {served!r}"
            )

        result = _as_batch_result(self.server.backend.embed_batch(texts), self.server.backend)
        vectors = self._validated_vectors(result.vectors, len(texts))
        tokens = sum(count_lexical_tokens(text) for text in texts)
        body = {
            "object": "list",
            "data": [
                {"object": "embedding", "index": index, "embedding": vector}
                for index, vector in enumerate(vectors)
            ],
            "model": served,
            "usage": {"prompt_tokens": tokens, "total_tokens": tokens},
        }
        self.server.stats.bump(embedding_requests=1, texts_embedded=len(texts),
                               tokens_counted=tokens)
        # 이 요청의 공개값을 그 요청의 응답 헤더에만 싣는다(백엔드 공유 상태를 읽지 않는다).
        self._disclosure = result.synthetic
        self._send_json(200, body, extra_headers={"X-Embedding-Token-Count": "lexical-approximation"})

    def _handle_v1_models(self) -> None:
        info = describe_backend(self.server.backend)
        entry = {
            "id": info["model_id"],
            "object": "model",
            "created": int(time.time()),
            "owned_by": "local",
            "dimensions": info["dimensions"],
            "synthetic": info["synthetic"],
            "status": info["status"],
            "note": info["note"],
        }
        if info["error"]:
            entry["error"] = info["error"]
        self._send_json(200, {
            "object": "list",
            "data": [entry],
            "backend": info,
            "cost": describe_cost(self.server.backend),
            "authentication": "none: unauthenticated local endpoint",
        })

    def _handle_healthz(self) -> None:
        info = describe_backend(self.server.backend)
        host = str(self.server.server_address[0])
        ready = info["status"] == "ready"
        body = {
            "status": "ok" if ready else "unavailable",
            "ok": ready,
            "service": "local-embedding",
            "backend": info,
            "cost": describe_cost(self.server.backend),
            # 바인드 주소는 이미 검증된 루프백 리터럴이다. 여기서 이름 해석을 하지 않는다
            # (health check 가 DNS 에 의존하면 안 된다).
            "bind": {"host": host, "loopback": is_loopback_literal(host)},
            "limits": self.server.limits(),
            "authentication": (
                "none: this is an unauthenticated local endpoint; anyone who can reach the "
                "port can call it"
            ),
            "uptime_seconds": round(time.monotonic() - self.server.started_at, 3),
            "requests": self.server.stats.snapshot(),
        }
        status = 200 if ready else 503
        if not ready:
            self.server.stats.bump(failed_requests=1)
        self._send_json(status, body)

    def _handle_stats(self) -> None:
        counts = self.server.stats.snapshot()
        body = {
            "object": "embedding_server.stats",
            "backend": describe_backend(self.server.backend),
            "cost": describe_cost(self.server.backend),
            "requests": {
                "total": counts["requests_total"],
                "embeddings": counts["embedding_requests"],
                "failed": counts["failed_requests"],
            },
            "texts": {"embedded": counts["texts_embedded"]},
            "tokens": {"counted": counts["tokens_counted"], "counter": "lexical-approximation"},
            "bytes_received": counts["bytes_received"],
            "limits": self.server.limits(),
            "uptime_seconds": round(time.monotonic() - self.server.started_at, 3),
        }
        self._send_json(200, body)

    # -- 요청 검증 ------------------------------------------------------- #
    def _validate_input(self, value: Any) -> List[str]:
        if isinstance(value, str):
            texts = [value]
        elif isinstance(value, list):
            if not value:
                raise MalformedRequestError("'input' must contain at least one string",
                                            param="input")
            for item in value:
                if not isinstance(item, str):
                    raise MalformedRequestError(
                        "'input' must be a string or a list of strings", param="input"
                    )
            texts = list(value)
        else:
            raise MalformedRequestError(
                "'input' must be a string or a list of strings", param="input"
            )
        if len(texts) > self.server.max_batch_texts:
            raise MalformedRequestError(
                f"'input' has {len(texts)} texts; batch limit is "
                f"{self.server.max_batch_texts}. Split the batch or raise --max-batch-texts.",
                code="batch_too_large", param="input",
            )
        for text in texts:
            if not text.strip():
                raise MalformedRequestError("'input' strings must be non-empty",
                                            param="input")
        return texts

    @staticmethod
    def _validated_vectors(vectors: Any, expected: int) -> List[List[float]]:
        if not isinstance(vectors, list) or len(vectors) != expected:
            raise BackendResponseError(
                f"backend returned {len(vectors) if isinstance(vectors, list) else 'no'} "
                f"vectors for {expected} texts"
            )
        width: Optional[int] = None
        normalised: List[List[float]] = []
        for vector in vectors:
            if not isinstance(vector, list) or not vector:
                raise BackendResponseError("backend returned an empty or non-list vector")
            try:
                values = [float(value) for value in vector]
            except (TypeError, ValueError):
                raise BackendResponseError(
                    "backend returned a vector with non-numeric values"
                ) from None
            if not all(math.isfinite(value) for value in values):
                raise BackendResponseError(
                    "backend returned a vector with non-finite values (NaN or Infinity); "
                    "such values cannot be serialized as valid JSON embeddings"
                )
            if width is None:
                width = len(values)
            elif len(values) != width:
                raise BackendResponseError("backend returned inconsistent vector dimensions")
            normalised.append(values)
        return normalised

    def _read_body(self) -> bytes:
        # 본문을 다 읽기 전에 거부하면 남은 바이트가 소켓에 남아 RST 를 유발한다.
        # 선언된 본문을 다 읽기 전에 응답할 때만 상한 있는 정리를 한다.
        self._body_consumed = False
        if self.headers.get("Transfer-Encoding"):
            raise MalformedRequestError(
                "chunked transfer-encoding is not supported; send Content-Length",
                code="unsupported_transfer_encoding",
            )
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise MalformedRequestError("missing Content-Length header",
                                        code="missing_content_length")
        try:
            length = int(raw_length)
        except ValueError:
            raise MalformedRequestError("Content-Length must be an integer",
                                        code="invalid_content_length") from None
        if length < 0:
            raise MalformedRequestError("Content-Length must not be negative",
                                        code="invalid_content_length")
        limit = self.server.max_body_bytes
        if length > limit:
            # 드레인하지 않는다: 본문을 다 받을 때까지 기다리면 거부 경로 자체가 멈춘다.
            raise MalformedRequestError(
                f"request body is {length} bytes; the limit is {limit}. Send fewer texts or "
                "raise --max-body-bytes. The body was not read and the connection is closed.",
                code="request_too_large",
            )
        deadline = time.monotonic() + self.server.max_read_seconds
        chunks: List[bytes] = []
        remaining = length
        pending = getattr(self, "_pending_body", b"")
        self._pending_body = b""
        if pending:
            # 머리말과 같은 수신에서 이미 도착한 본문 바이트를 먼저 소비한다.
            take = pending[:remaining]
            chunks.append(take)
            remaining -= len(take)
        what = f"request body ({length} bytes)"
        while remaining > 0:
            # 버퍼 파일 객체가 아니라 소켓에서 직접, 수신마다 남은 예산으로 타임아웃을 다시
            # 걸고 한 번만 recv 한다(버퍼 read(n) 의 내부 반복 recv 우회를 막는다).
            chunk = self._recv_with_budget(min(remaining, _READ_CHUNK_BYTES), deadline, what)
            if not chunk:
                raise MalformedRequestError("request body ended before Content-Length",
                                            code="truncated_body")
            remaining -= len(chunk)
            chunks.append(chunk)
        body = b"".join(chunks)
        self.server.stats.bump(bytes_received=len(body))
        self._body_consumed = True
        return body

    # -- 응답 ------------------------------------------------------------ #
    def _send_error(self, exc: EmbeddingServerError) -> None:
        status, error_type, code = classify_error(exc)
        payload: Dict[str, Any] = {"error": {
            "message": str(exc), "type": error_type, "code": code,
        }}
        param = getattr(exc, "param", None)
        if param:
            payload["error"]["param"] = param
        self._send_json(status, payload)

    def _send_json(self, status: int, payload: Mapping[str, Any], *,
                   extra_headers: Optional[Mapping[str, str]] = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        backend = self.server.backend
        free = getattr(backend, "billing_known", None) is True
        # 요청별 공개값이 있으면 그것을 쓰고, 없으면(요청과 무관한 경로) 백엔드 공개값을 쓴다.
        # 백엔드 속성을 무조건 읽으면 동시 원격 요청이 서로의 공개값을 덮어쓴다.
        disclosure = getattr(self, "_disclosure", _USE_BACKEND_DISCLOSURE)
        if disclosure is _USE_BACKEND_DISCLOSURE:
            disclosure = getattr(backend, "synthetic", None)
        if not isinstance(disclosure, bool):
            disclosure_header = "unknown"
        else:
            disclosure_header = "true" if disclosure else "false"
        headers = {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": str(len(body)),
            "Connection": "close",
            "X-Embedding-Backend": type(backend).__name__,
            "X-Embedding-Model": str(getattr(backend, "model_id", "")),
            "X-Embedding-Synthetic": disclosure_header,
            "X-Embedding-Free": "true" if free else "false",
            "X-Embedding-Cost-USD": "0" if free else "unknown",
        }
        if extra_headers:
            headers.update(extra_headers)
        try:
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):  # 클라이언트가 먼저 끊었다
            LOGGER.debug("client closed the connection before the response was written")
        finally:
            self.close_connection = True
            # 읽지 않은 요청 본문이 남은 채 닫으면 커널이 RST 를 보내 방금 쓴 응답이
            # 클라이언트에서 사라진다. 본문을 다 읽지 못한 경우에만 상한 있는 정리를 한다.
            if not getattr(self, "_body_consumed", True):
                self.server.finish_connection(self.connection)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - 표준 시그니처
        LOGGER.debug("%s - %s", self.client_address[0], format % args)

    def log_error(self, format: str, *args: Any) -> None:  # noqa: A002
        LOGGER.warning("%s - %s", self.client_address[0], format % args)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m engine.embedding_server",
        description=(
            "OpenAI-compatible local embedding server (stdlib only). Default backend is the "
            "synthetic HashBackend: deterministic token-hash vectors, NOT semantic embeddings."
        ),
    )
    parser.add_argument("--backend", default="hash", choices=("hash", "remote", "local"),
                        help="hash (synthetic, default), remote (loopback forward), local (needs weights)")
    parser.add_argument("--host", default=DEFAULT_HOST, help="bind host (loopback by default)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="bind port (0 = ephemeral)")
    parser.add_argument("--allow-non-loopback", action="store_true",
                        help="permit binding to a non-loopback interface (logged as a warning)")
    parser.add_argument("--dimensions", type=int, default=None, help="embedding width")
    parser.add_argument("--model", default=None, help="model id advertised by /v1/models")
    parser.add_argument("--remote-url", default=None,
                        help=f"loopback API root for the remote backend (or set {ENV_REMOTE_URL})")
    parser.add_argument("--local-weights", default=None,
                        help=f"path to local weights for the local backend (or set {ENV_LOCAL_WEIGHTS})")
    parser.add_argument("--max-body-bytes", type=int, default=DEFAULT_MAX_BODY_BYTES)
    parser.add_argument("--max-batch-texts", type=int, default=DEFAULT_MAX_BATCH_TEXTS)
    parser.add_argument("--max-concurrent-requests", type=int,
                        default=DEFAULT_MAX_CONCURRENT_REQUESTS,
                        help="handler thread cap; extra requests get an immediate 503")
    parser.add_argument("--socket-timeout-seconds", type=float,
                        default=DEFAULT_SOCKET_TIMEOUT_SECONDS,
                        help="per-read socket timeout for a client connection")
    parser.add_argument("--max-read-seconds", type=float, default=DEFAULT_MAX_READ_SECONDS,
                        help="total budget for reading one request body (408 when exceeded)")
    parser.add_argument("--log-level", default="INFO",
                        choices=("DEBUG", "INFO", "WARNING", "ERROR"))
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        backend = select_backend(
            args.backend,
            dimensions=args.dimensions,
            model_id=args.model,
            remote_url=args.remote_url or os.environ.get(ENV_REMOTE_URL),
            local_weights=args.local_weights or os.environ.get(ENV_LOCAL_WEIGHTS),
        )
        # 로컬 백엔드는 시작 시점에 크게 실패한다(적재된 척하지 않는다).
        if args.backend == "local":
            backend.dimensions  # noqa: B018 - 설정 검증 목적
        server = create_server(
            backend, host=args.host, port=args.port,
            # 명시적 플래그 전용: 환경변수만으로는 off-device 바인드를 허용하지 않는다.
            allow_non_loopback=bool(args.allow_non_loopback),
            max_body_bytes=args.max_body_bytes,
            max_batch_texts=args.max_batch_texts,
            max_concurrent_requests=args.max_concurrent_requests,
            socket_timeout_seconds=args.socket_timeout_seconds,
            max_read_seconds=args.max_read_seconds,
        )
    except (EmbeddingServerError, ValueError, OSError) as exc:
        LOGGER.error("cannot start embedding server: %s", exc)
        return 2
    base = server.base_url()
    info = describe_backend(backend)
    LOGGER.info("serving %s on %s (backend=%s, synthetic=%s, free=%s)",
                info["model_id"], base, info["backend"], info["synthetic"],
                describe_cost(backend)["free"])
    LOGGER.info("endpoints: POST /v1/embeddings, GET /v1/models, GET /healthz, GET /stats "
                "(no authentication: local endpoint only)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOGGER.info("shutting down embedding server")
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI 진입점
    raise SystemExit(main())
