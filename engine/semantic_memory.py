"""의미 검색 계층: 기존 FTS5 메모리 위에 로컬 임베딩 벡터를 덧붙이는 부가 모듈.

``memory_layer``(FTS5 렉시컬 검색)를 대체하지 않고 **그 옆에** 붙는다:

* 벡터는 기존 스키마를 건드리지 않고 별도 테이블 ``semantic_vectors``에만 저장한다.
  키는 ``(namespace, record_id)``이고 ``namespace`` 열이 기존 격리를 그대로 비추므로,
  한 namespace의 검색은 다른 namespace의 행을 후보로도 보지 않는다(SQL WHERE 절).
* 쓰기/읽기 연결은 **호출자가 넘긴 연결 하나뿐**이다: ``.conn``을 가진 저장소
  (``MemoryLayer``/``HybridContextMemoryEngine``) 또는 ``sqlite3.Connection``. 이 계층은
  자기 연결을 몰래 열지 않고, ``isolation_level``/``journal_mode``/``row_factory``를
  바꾸지 않으며, ``BEGIN IMMEDIATE``(이미 트랜잭션이 열려 있으면 SAVEPOINT)만 연다.
  저장소 스키마도 ``SAVEPOINT``/``BEGIN IMMEDIATE`` 안에서 만든다(``executescript``는
  암묵적 COMMIT을 하므로 쓰지 않는다): 호출자가 열어 둔 트랜잭션은 그대로 살아 있고,
  호출자가 롤백하면 이 테이블도 함께 사라진다 — 경계를 넘지 않는다. 테이블 부재는
  연결을 만지는 공개 연산(``index``/``delete``/``search``/``hybrid_search``/``stats``)
  마다 다시 확인해 그 자리에서 만든다. 그래서 테이블 존재는 "누가 먼저 이 연결을
  썼는지"나 인스턴스 생성 시점의 상태에 의존하지 않는다. 자체 연결이
  필요하면 ``SemanticMemory.open(path)``로 **명시적으로** 열어야 하며, 그때도 저널
  모드는 건드리지 않는다(기본 경로 문자열 인자는 지원하지 않는다).
* 키워드 점수는 기존 FTS5 경로를 그대로 재사용한다. ``MemoryLayer``면
  ``MemoryLayer.search``(namespace별 색인의 BM25 + RRF, 한국어 접두 매칭, LIKE 폴백),
  ``HybridContextMemoryEngine``이면 그 ``search(category=...)``의 BM25다. 어느 쪽도
  이 모듈이 다시 구현하지 않는다.

임베딩은 **루프백 전용 OpenAI 호환 엔드포인트**로만 얻는다:
``POST {base_url}/v1/embeddings``, 본문 ``{"model", "input"}``. 기본값은 이 저장소의
``engine.embedding_server`` 기본 바인드(``http://127.0.0.1:8099``, 모델
``local/hash-embedding-v1``)와 일치하며, 루프백이 아닌 URL은 생성 시점에
``NonLoopbackEndpointError``로 거부한다(원격 임베딩 호출은 무비용 목표를 깬다).
``base_url``에 API 루트(``.../v1``)를 붙여 넘기는 관행도 받아들이되 경로는 언제나
``{base_url}/v1/embeddings`` 하나만 만든다(``/v1/v1/...``를 만들지 않는다).
의존성은 표준 라이브러리뿐이다(``http.client``). HTTP 정책은 고정되어 있다:
``urllib``의 기본 오프너를 쓰지 않으므로 프록시를 전혀 쓰지 않고(환경변수 무시)
리다이렉트도 따라가지 않는다(``http.client``는 3xx를 그대로 돌려주고, 이 계층은 3xx를
``EmbeddingUnavailableError``로 처리한다 — 루프백 밖으로 튕겨 나가는 우회 차단).
요청 직전에 호스트를 실제로 해석해 **모든** 주소가 루프백인지 확인한 뒤 그 주소로
고정(pin)해 접속한다(DNS 재해석으로 새는 경로를 막는다). 응답은 ``data[i].index``를
**필수**로 요구하고(누락/중복/범위 밖 거부), ``model`` 필드가 요청한 모델과 같은지
확인한다(다른 모델의 벡터를 설정된 id로 라벨링하지 않는다).

**의미 품질은 주장하지 않는다.** 이 계층이 보장하는 것은 배선·격리·정확성·진실성이며,
벡터가 실제로 "의미"인지는 전적으로 뒤에 선 모델이 결정한다. 그 구분을 호출자가 알 수
있도록 모든 결과가 ``embedding_model``(응답을 만든 모델 id)을 싣는다. 참고로 이 저장소의
``embedding_server`` 기본 백엔드 ``HashBackend``는 **합성(synthetic) 토큰 해시 벡터**라서
의미 임베딩이 아니고, 그 모델 id로 임베딩했다면 유사도는 어휘 겹침만 반영한다.

하이브리드 가중치(문서화된 규칙)
--------------------------------
``hybrid_search``는 두 신호를 **후보 집합 안에서 min-max 정규화**한 뒤 가중 합한다::

    vector_norm  = (cosine  - min_cosine ) / (max_cosine  - min_cosine )   # 범위 동일하면 1.0
    keyword_norm = (keyword - min_keyword) / (max_keyword - min_keyword)   # 범위 동일하면 1.0
    score        = HYBRID_VECTOR_WEIGHT * vector_norm + HYBRID_KEYWORD_WEIGHT * keyword_norm

``keyword``는 기존 키워드 경로 원점수이며 언제나 "클수록 좋음"으로 정렬되어 있다
(``MemoryLayer``의 RRF 합, ``HybridContextMemoryEngine``의 BM25는 부호를 뒤집어 맞춘다).

가중치는 ``HYBRID_VECTOR_WEIGHT = 0.6``, ``HYBRID_KEYWORD_WEIGHT = 0.4``(합 1.0)이며,
한쪽 신호에만 등장한 후보는 반대쪽 정규화 값을 0.0으로 받는다. 동점은 ``record_id``
오름차순으로 깨서 결정적이다. 정규화 범위는 잘라내기 전 전체 후보에서 계산한다.

저하(degradation) 규칙(문서화된 규칙)
-----------------------------------
임베딩 엔드포인트가 **도달 불가**(연결 실패/타임아웃/비2xx/JSON이 아닌 본문)면 가짜
벡터를 만들지 않는다. 대신 기존 FTS5 키워드 검색만으로 결과를 만들고 ``mode="keyword"``,
``degraded=True``, ``degraded_reason="embedding endpoint unavailable: ..."``,
``embedding_model=None``으로 그 사실을 밝힌다. ``index``도 같은 상황에서 아무 것도
쓰지 않고 ``status="unavailable"``과 이유를 돌려준다. 반면 JSON 본문이 스키마를 어기거나
(항목 수/``index``/``embedding`` 누락) 차원 상한·차원 불일치·비유한 값 같은 **계약 위반은
저하 대상이 아니라 예외**다(조용히 키워드로 내려가지 않는다).

같은 라벨 규칙이 두 경우에 더 적용된다: (a) 임베딩 클라이언트가 아예 설정되지 않았을 때
(``client=None``), (b) 엔드포인트는 살아 있지만 이 namespace/model에 비교할 저장 벡터가
하나도 없을 때. 두 경우 모두 벡터 신호가 실제로 계산되지 않았으므로 ``mode="keyword"``와
``vectors_available=False``로 보고한다("하이브리드"라고 부르지 않는다). 벡터 쪽만 있고
키워드 매칭이 0건이면 ``hybrid_search``는 ``mode="vector"``로 보고한다.

정확성/경계
-----------
* 코사인은 **먼저 각 성분을 노름으로 나눈** 뒤 내적해 계산한다(``sum((a/|a|)*(b/|b|))``).
  크기 1e308 벡터도, 1e-200 벡터도 float 범위 안에서 안전하다: 원시 내적/노름의
  곱은 넘치거나 0으로 언더플로할 수 있지만 정규화 후 성분은 절댓값 ≤ 1이다.
  결과는 [-1, 1]로 클램프해 부동소수 오차가 ±1을 넘지 않는다.
* 질의 노름이 0이면 나눗셈 없이 유사도 0.0(``zero_query_vector=True``), 저장 노름이
  0이면 0.0이다. 어떤 경로에서도 NaN을 만들지 않는다.
* 저장 벡터는 ``dim`` 열로 걸러 SQL 단계에서 같은 차원만 후보가 된다(다른 차원과의
  짝짓기 금지). 행 자체가 손상돼 길이가 다르면 파이썬 단계에서 한 번 더 버린다.
  저장된 차원과 다른 질의 임베딩은 **빈 결과가 아니라** ``DimensionMismatchError``다
  (차원 드리프트를 "저장 벡터 없음"으로 오해하지 않는다).
* 같은 namespace/model의 기존 차원과 다른 임베딩은 ``DimensionMismatchError``,
  ``max_dimensions`` 초과는 ``DimensionCapExceededError``로 거부한다.
* 하이브리드 융합은 **실제로 벡터 후보에 있던 레코드만** 벡터 신호를 갖는다. 키워드
  정체성은 (namespace, record_id)로 중복 제거되고(같은 문서가 두 번 색인되어도 한 번),
  키워드에만 있는 레코드는 벡터 점수를 0.0으로 받되 ``mode="keyword"``다 — 절대
  "hybrid"나 "vector"로 승격되지 않는다.
* 후보는 통째로 읽지 않는다. 질의 토큰 LIKE 상위 집합을 ``candidate_limit``까지 먼저
  읽고, 남은 예산만큼 최근 행을 채워 **최대 ``scan_limit``개**로 제한한다. 잘렸으면
  ``truncated=True``와 ``candidates_scanned``로 알린다.
* 호출자 연결의 ``row_factory``/``isolation_level``/WAL 설정은 바꾸지 않고, 모든 질의는
  위치 기반 튜플로 행을 읽는다(다른 코드의 연결 설정을 뒤집지 않는다).

공개 API
--------
``SemanticMemory(store, *, namespace, client, base_url, model, timeout, max_dimensions,
candidate_limit, scan_limit)`` — ``store``는 ``MemoryLayer``/``HybridContextMemoryEngine``/
``sqlite3.Connection``(경로 문자열은 거부; 필요하면 ``SemanticMemory.open(path)``).
``client=`` 를 주면 그 클라이언트를 쓰고(``model_id`` 필수), ``client=None`` 은
"엔드포인트 없음"을 명시한다.
메서드: ``index(records, namespace, batch_size=)``, ``search(query, namespace, k=5)``,
``hybrid_search(query, namespace, k=5)``, ``delete(record_id, namespace)``,
``stats(namespace)``, ``capabilities()``, ``close()``.
헬퍼: ``LocalOpenAIEmbeddingClient``, ``ensure_loopback_base_url``,
``records_from_memory_layer``, ``records_from_fts5_engine``.
결과 dict의 진실성 필드: ``mode``, ``embedding_model``, ``degraded``,
``degraded_reason``, ``vectors_available``, ``notice``, ``candidates_scanned``,
``truncated``, ``zero_query_vector``. 각 결과에는 ``mode``/``signals``/``similarity``/
``keyword_score``/``vector_score_norm``/``keyword_score_norm`` 이 실린다.
"""
from __future__ import annotations

import contextlib
import http.client
import ipaddress
import json
import math
import re
import socket
import sqlite3
from collections.abc import Iterator, Mapping, Sequence
from datetime import datetime, timezone
from typing import Any, Optional, Protocol
from urllib.parse import urlsplit

from .fts5_memory import HybridContextMemoryEngine
from .memory_layer import MemoryLayer

__all__ = [
    "SemanticMemory",
    "LocalOpenAIEmbeddingClient",
    "EmbeddingClient",
    "ensure_loopback_base_url",
    "records_from_memory_layer",
    "records_from_fts5_engine",
    "SemanticMemoryError",
    "NonLoopbackEndpointError",
    "EmbeddingError",
    "EmbeddingResponseError",
    "EmbeddingUnavailableError",
    "DimensionMismatchError",
    "DimensionCapExceededError",
    "DEFAULT_BASE_URL",
    "DEFAULT_MODEL_ID",
    "MAX_DIMENSIONS",
    "HYBRID_VECTOR_WEIGHT",
    "HYBRID_KEYWORD_WEIGHT",
]

DEFAULT_BASE_URL = "http://127.0.0.1:8099"   # engine.embedding_server 기본 바인드
DEFAULT_MODEL_ID = "local/hash-embedding-v1"  # 그 서버의 기본 HashBackend 모델 id(합성!)
DEFAULT_TIMEOUT = 10.0
MAX_DIMENSIONS = 4096
HYBRID_VECTOR_WEIGHT = 0.6
HYBRID_KEYWORD_WEIGHT = 0.4
DEFAULT_CANDIDATE_LIMIT = 512
DEFAULT_SCAN_LIMIT = 2_000
DEFAULT_BATCH_SIZE = 8
EMBEDDINGS_PATH = "/v1/embeddings"

_UNSET: Any = object()

_LOOPBACK_NAMES = frozenset({"localhost", "ip6-localhost", "localhost.localdomain"})
_TERM = re.compile(r"[A-Za-z0-9_가-힣]+")

# 부가 DDL. ``executescript``는 암묵적으로 COMMIT을 하므로(호출자 트랜잭션을 끊는다)
# 절대 쓰지 않고, 문장 하나씩 트랜잭션 안에서 실행한다.
DDL: tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS semantic_vectors (
        namespace TEXT NOT NULL,
        record_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dim INTEGER NOT NULL,
        norm REAL NOT NULL,
        vector_json TEXT NOT NULL,
        content TEXT NOT NULL,
        doc_id INTEGER,
        chunk_id INTEGER,
        source TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        indexed_at TEXT NOT NULL,
        PRIMARY KEY (namespace, record_id)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS semantic_vectors_lookup
        ON semantic_vectors (namespace, model_id, dim)
    """,
)


class SemanticMemoryError(Exception):
    """이 계층의 공통 예외."""


class NonLoopbackEndpointError(SemanticMemoryError):
    """임베딩 base_url이 루프백이 아니다(원격 호출 금지)."""


class EmbeddingError(SemanticMemoryError):
    """임베딩 계약 위반(빈 벡터, 숫자 아님 등)."""


class EmbeddingResponseError(EmbeddingError):
    """엔드포인트 응답이 OpenAI 임베딩 스키마와 맞지 않는다."""


class EmbeddingUnavailableError(EmbeddingError):
    """엔드포인트에 도달할 수 없거나 2xx가 아니다(문서화된 저하 트리거)."""


class DimensionMismatchError(SemanticMemoryError):
    """벡터 차원이 일치하지 않는다."""


class DimensionCapExceededError(SemanticMemoryError):
    """벡터 차원이 max_dimensions 상한을 넘는다."""


class EmbeddingClient(Protocol):
    """로컬 임베딩 클라이언트 계약. ``model_id``는 결과에 그대로 실린다."""

    model_id: str

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """텍스트 배치를 같은 순서의 벡터 배치로 바꾼다."""


def ensure_loopback_base_url(base_url: str) -> str:
    """base_url이 루프백 HTTP(S)인지 확인하고 정규화된 문자열을 돌려준다.

    ``localhost`` 계열 이름과 IPv4/IPv6 루프백 주소만 허용한다. ``0.0.0.0``처럼
    루프백이 아닌 주소는 거부한다(바인딩 주소이지 접속지가 아니다). 끝의 ``/``와
    관행적인 ``/v1`` 접미사는 떼어내, 호출자가 ``.../v1``을 넘기든 루트를 넘기든
    요청 경로가 ``{base}/v1/embeddings`` 하나로 정규화되게 한다.
    """
    if not isinstance(base_url, str) or not base_url.strip():
        raise ValueError("base_url must be a non-empty str")
    parts = urlsplit(base_url.strip())
    if parts.scheme not in ("http", "https"):
        raise NonLoopbackEndpointError(
            f"embedding base_url must be http(s), got {base_url!r}")
    host = (parts.hostname or "").lower()
    if not host:
        raise NonLoopbackEndpointError(f"embedding base_url has no host: {base_url!r}")
    _ensure_loopback_host(host, base_url)
    netloc = parts.netloc
    path = parts.path.rstrip("/")
    if path.endswith("/v1"):
        path = path[: -len("/v1")]
    return f"{parts.scheme}://{netloc}{path}"


def _ensure_loopback_host(host: str, base_url: str) -> None:
    """이름/IP가 루프백인지 확인한다(비루프백이면 NonLoopbackEndpointError)."""
    if host.lower() in _LOOPBACK_NAMES:
        return
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        raise NonLoopbackEndpointError(
            f"embedding base_url {base_url!r} is not a loopback address; a remote "
            "embedding call would defeat the zero-cost goal (only 127.0.0.0/8, ::1 or "
            "localhost are accepted)") from None
    if not address.is_loopback:
        raise NonLoopbackEndpointError(
            f"embedding base_url {base_url!r} is not a loopback address; a remote "
            "embedding call would defeat the zero-cost goal (only 127.0.0.0/8, ::1 or "
            "localhost are accepted)")


def _resolve_loopback(host: str, port: int, base_url: str) -> str:
    """호스트를 해석해 **모든** 주소가 루프백인지 확인하고, 접속에 쓸 주소를 고정한다.

    이름 해석 결과가 하나라도 비루프백이면 거부한다(DNS가 나중에 바뀌어도 요청은 이미
    검증한 주소로 고정되므로 우회할 수 없다). 이름 자체가 검증된 루프백 이름이거나
    루프백 IP 표기면 해석 결과도 루프백이어야 한다.
    """
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError as exc:
        raise EmbeddingUnavailableError(
            f"cannot resolve embedding endpoint host {host!r}: {exc}") from exc
    addresses = []
    for info in infos:
        address = str(info[4][0])
        try:
            parsed = ipaddress.ip_address(address.split("%")[0])
        except ValueError as exc:  # pragma: no cover - getaddrinfo는 유효한 주소만 준다
            raise NonLoopbackEndpointError(
                f"unresolvable address {address!r} for {base_url!r}") from exc
        if not parsed.is_loopback:
            raise NonLoopbackEndpointError(
                f"embedding base_url {base_url!r} resolves to the non-loopback address "
                f"{address}; refusing to send the request outside loopback")
        addresses.append(address)
    if not addresses:
        raise EmbeddingUnavailableError(
            f"embedding endpoint host {host!r} resolved to no address")
    # IPv4 우선(루프백 스텁은 대부분 AF_INET). 고정된 주소 문자열을 그대로 접속에 쓴다.
    return next((address for address in addresses if ":" not in address), addresses[0])


class LocalOpenAIEmbeddingClient:
    """루프백 OpenAI 호환 ``/v1/embeddings`` 클라이언트(표준 라이브러리 전용).

    요청: ``POST {base_url}/v1/embeddings``, ``{"model": ..., "input": [...]}``.
    프록시를 쓰지 않고(환경변수 무시) 리다이렉트를 따르지 않으며, 접속 직전에 해석한
    주소가 루프백인지 확인해 그 주소로 고정한다. 응답의 ``data[*].index``는 필수이고
    중복/누락/범위 밖이면 거부하며(입력과 다른 벡터를 짝짓지 않는다), ``model`` 필드가
    요청 모델과 다르면 ``EmbeddingResponseError``다(설정 id로 남의 벡터를 라벨링 금지).
    도달 불가/비2xx는 :class:`EmbeddingUnavailableError`, 스키마 위반은
    :class:`EmbeddingResponseError`다.
    """

    def __init__(self, base_url: str = DEFAULT_BASE_URL, model: str = DEFAULT_MODEL_ID,
                 timeout: float = DEFAULT_TIMEOUT) -> None:
        if not isinstance(model, str) or not model.strip():
            raise ValueError("model must be a non-empty str")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        self.base_url = ensure_loopback_base_url(base_url)
        self.model_id = model.strip()
        self.timeout = float(timeout)

    @property
    def endpoint(self) -> str:
        return f"{self.base_url}{EMBEDDINGS_PATH}"

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        payload = [str(text) for text in texts]
        if not payload:
            return []
        body = json.dumps({"model": self.model_id, "input": payload}).encode("utf-8")
        raw = self._post(body)
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise EmbeddingResponseError(
                f"embeddings endpoint returned non-JSON body: {exc}") from exc
        return self._vectors(parsed, len(payload))

    def _post(self, body: bytes) -> bytes:
        """리다이렉트/프록시 없는 POST. 접속지는 검증된 루프백 주소로 고정된다."""
        parts = urlsplit(self.base_url)
        host = (parts.hostname or "").lower()
        port = parts.port or (443 if parts.scheme == "https" else 80)
        path = f"{parts.path}{EMBEDDINGS_PATH}" or EMBEDDINGS_PATH
        pinned = _resolve_loopback(host, port, self.base_url)
        connection_class = (http.client.HTTPSConnection if parts.scheme == "https"
                            else http.client.HTTPConnection)
        headers = {"Content-Type": "application/json", "Accept": "application/json",
                   "Connection": "close"}
        host_header = f"[{host}]" if ":" in host else host
        headers["Host"] = f"{host_header}:{port}" if parts.port else host_header
        connection = connection_class(pinned, port, timeout=self.timeout)
        try:
            connection.request("POST", path, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read()
            status = int(response.status)
            if status < 200 or status >= 300:
                # 3xx도 여기로 온다(리다이렉트를 따라가지 않는다: 루프백 밖으로 새는 경로).
                raise EmbeddingUnavailableError(
                    f"embeddings endpoint returned HTTP {status} at {self.endpoint}: "
                    f"{raw.decode('utf-8', 'replace')[:200]}")
        except (OSError, http.client.HTTPException) as exc:
            raise EmbeddingUnavailableError(
                f"embeddings endpoint unreachable at {self.endpoint}: {exc}") from exc
        finally:
            connection.close()
        return raw

    def _vectors(self, parsed: Any, expected: int) -> list[list[float]]:
        if not isinstance(parsed, Mapping):
            raise EmbeddingResponseError("embeddings response must be a JSON object")
        served = parsed.get("model")
        if not isinstance(served, str) or served != self.model_id:
            # 응답이 밝힌 모델 id가 없거나 다르면, 설정 id로 남의 벡터를 라벨링하지 않는다.
            raise EmbeddingResponseError(
                f"embeddings response reports model {served!r}, expected {self.model_id!r}")
        data = parsed.get("data")
        if not isinstance(data, list) or len(data) != expected:
            raise EmbeddingResponseError(
                f"embeddings response must carry {expected} items in 'data'")
        ordered: list[Any] = [None] * expected
        for item in data:
            if not isinstance(item, Mapping):
                raise EmbeddingResponseError("embeddings response items must be JSON objects")
            index = item.get("index")
            # index는 필수다: 없으면 위치로 추측하지 않는다(순서가 뒤집힌 응답을 잘못 짝짓는다).
            if not isinstance(index, int) or isinstance(index, bool):
                raise EmbeddingResponseError(
                    "embeddings response item is missing an integer 'index'")
            if not 0 <= index < expected or ordered[index] is not None:
                raise EmbeddingResponseError(
                    f"embeddings response has a duplicate or out-of-range 'index': {index}")
            ordered[index] = item
        vectors: list[list[float]] = []
        for item in ordered:
            embedding = item.get("embedding") if isinstance(item, Mapping) else None
            if not isinstance(embedding, list) or not embedding:
                raise EmbeddingResponseError("embeddings response item has no 'embedding'")
            vectors.append(embedding)
        return vectors

    def __repr__(self) -> str:  # pragma: no cover - 진단용
        return f"LocalOpenAIEmbeddingClient({self.endpoint!r}, model={self.model_id!r})"


def records_from_memory_layer(layer: Any, namespace: Optional[str] = None) -> list[dict[str, Any]]:
    """``MemoryLayer``의 청크를 ``index`` 입력 레코드로 **읽기 전용** 변환한다.

    쓰기는 하지 않는다(같은 연결을 읽기만 한다). ``record_id``는
    ``f"chunk:{chunk_id}"``이며, ``MemoryLayer.search`` 결과의 청크와 같은 정체성이라
    하이브리드 융합에서 두 신호가 같은 레코드로 합쳐진다.
    """
    conn = getattr(layer, "conn", None)
    if not isinstance(conn, sqlite3.Connection):
        raise TypeError("layer must expose a sqlite3 connection as .conn")
    ns = _namespace(namespace if namespace is not None else getattr(layer, "namespace", None))
    rows = conn.execute(
        "SELECT chunks.chunk_id, chunks.doc_id, chunks.ordinal, chunks.content, "
        "documents.source, documents.metadata_json FROM chunks "
        "JOIN documents USING (doc_id) WHERE chunks.namespace = ? "
        "ORDER BY chunks.chunk_id", (ns,)).fetchall()
    records = []
    for row in rows:
        # 위치 기반 접근: 호출자 연결의 row_factory 설정에 의존하지 않는다.
        chunk_id, doc_id, ordinal, content, source, metadata_json = row
        metadata = json.loads(metadata_json)
        metadata.setdefault("ordinal", int(ordinal))
        records.append({"record_id": f"chunk:{int(chunk_id)}", "text": content,
                        "doc_id": int(doc_id), "chunk_id": int(chunk_id),
                        "source": source, "metadata": metadata})
    return records


def records_from_fts5_engine(engine: Any, category: Optional[str] = None) -> list[dict[str, Any]]:
    """``HybridContextMemoryEngine``의 ``knowledge_fts`` 행을 ``index`` 입력으로 변환한다.

    읽기 전용이다. ``HybridContextMemoryEngine``에는 namespace가 없으므로 그 ``category``를
    namespace로 쓴다(이 계층의 규칙: ``search(..., namespace=ns)`` → ``category=ns``).
    ``record_id``는 ``f"fts:{category}:{doc_id}"``이고 ``HybridContextMemoryEngine.search``가
    돌려주는 (doc_id, category)와 같은 정체성이라 하이브리드 융합이 같은 레코드로 합친다.
    같은 (category, doc_id)를 두 번 색인한 행은 정체성이 같고 본문도 같으므로 하나로 합쳐진다.
    """
    conn = getattr(engine, "conn", None)
    if not isinstance(conn, sqlite3.Connection):
        raise TypeError("engine must expose a sqlite3 connection as .conn")
    sql = "SELECT rowid, doc_id, category, title, content FROM knowledge_fts"
    params: tuple[Any, ...] = ()
    if category is not None:
        sql += " WHERE category = ?"
        params = (_namespace(category),)
    rows = conn.execute(sql + " ORDER BY rowid", params).fetchall()
    records: dict[str, dict[str, Any]] = {}
    for row in rows:
        _rowid, doc_id, row_category, title, content = row
        record_id = f"fts:{row_category}:{doc_id}"
        records.setdefault(record_id, {
            "record_id": record_id, "text": content,
            "source": f"{row_category}/{title}",
            "metadata": {"category": row_category, "title": title, "doc_id": doc_id}})
    return list(records.values())


def _namespace(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("namespace must be a non-empty str")
    return value.strip()


def _norm(vector: Sequence[float]) -> float:
    return math.hypot(*vector)


def _cosine(query: Sequence[float], query_norm: float,
            vector: Sequence[float], vector_norm: float) -> float:
    """노름을 재사용한 코사인. 0으로 나누지 않고, 부동소수 오차는 [-1, 1]로 접는다."""
    if query_norm == 0.0 or vector_norm == 0.0:
        return 0.0
    dot = math.fsum((a / query_norm) * (b / vector_norm) for a, b in zip(query, vector))
    return max(-1.0, min(1.0, dot))


def _terms(text: str) -> list[str]:
    return [term.lower() for term in _TERM.findall(text or "")]


def _like(term: str) -> str:
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _minmax(values: Mapping[str, float]) -> dict[str, float]:
    """후보 집합 안 min-max 정규화. 범위가 0이면(후보 1개 포함) 전부 1.0."""
    if not values:
        return {}
    low, high = min(values.values()), max(values.values())
    if high == low:
        return {key: 1.0 for key in values}
    return {key: (value - low) / (high - low) for key, value in values.items()}


def _opt_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"expected an int, got {value!r}") from exc


class SemanticMemory:
    """기존 메모리 저장소 옆에 벡터를 붙이는 검색 계층.

    ``store``는 ``MemoryLayer``/``HybridContextMemoryEngine``(권장; 같은 연결/WAL을
    그대로 쓴다) 또는 ``sqlite3.Connection``이다. 경로 문자열은 생성자에서 거부하며,
    자체 연결이 필요할 때만 ``SemanticMemory.open(path, ...)``로 명시적으로 연다(그때도
    저널 모드는 바꾸지 않는다).
    """

    def __init__(self, store: Any, *, namespace: str = "default",
                 client: Any = _UNSET,
                 base_url: str = DEFAULT_BASE_URL, model: str = DEFAULT_MODEL_ID,
                 timeout: float = DEFAULT_TIMEOUT, max_dimensions: int = MAX_DIMENSIONS,
                 candidate_limit: int = DEFAULT_CANDIDATE_LIMIT,
                 scan_limit: int = DEFAULT_SCAN_LIMIT,
                 _owns_conn: bool = False) -> None:
        if max_dimensions <= 0:
            raise ValueError("max_dimensions must be positive")
        # 잘못된 base_url은 연결을 열기 전에 거부한다(자원 누수/반쯤 만든 인스턴스 방지).
        self.base_url = ensure_loopback_base_url(base_url)
        self.namespace = _namespace(namespace)
        self.max_dimensions = int(max_dimensions)
        self.candidate_limit = max(int(candidate_limit), 1)
        self.scan_limit = max(int(scan_limit), 1)
        # client=None은 "엔드포인트를 쓰지 않는 순수 키워드 저장소"라는 명시적 선택이다.
        # 인자를 아예 넘기지 않으면(센티넬) 루프백 기본 클라이언트를 만든다.
        if client is _UNSET:
            resolved_client: Optional[EmbeddingClient] = LocalOpenAIEmbeddingClient(
                base_url=base_url, model=model, timeout=timeout)
        elif client is not None:
            if not callable(getattr(client, "embed", None)):
                raise TypeError("client must expose embed(texts) -> list[list[float]]")
            model_id = getattr(client, "model_id", None)
            if not isinstance(model_id, str) or not model_id.strip():
                raise ValueError("client must expose a non-empty 'model_id'")
            resolved_client = client
        else:
            resolved_client = None
        self.client = resolved_client
        self.store: Any = None
        connection = getattr(store, "conn", None)
        if isinstance(connection, sqlite3.Connection):
            self.store, self.conn, self._owns_conn = store, connection, bool(_owns_conn)
        elif isinstance(store, sqlite3.Connection):
            self.conn, self._owns_conn = store, bool(_owns_conn)
        elif isinstance(store, str):
            raise TypeError(
                "store must be a MemoryLayer, HybridContextMemoryEngine or sqlite3.Connection "
                "(path strings are not accepted; use SemanticMemory.open(path) for an explicit "
                "owned connection without changing journal_mode)")
        else:
            raise TypeError(
                "store must be a MemoryLayer, HybridContextMemoryEngine or sqlite3.Connection")
        # 호출자의 row_factory/isolation_level/트랜잭션 경계는 건드리지 않는다:
        # executescript는 암묵적 COMMIT을 하므로 쓰지 않고, 부재 시에만 SAVEPOINT/트랜잭션
        # 안에서 테이블과 인덱스를 만든다.
        self._ensure_schema()

    @classmethod
    def open(cls, path: str, **kwargs: Any) -> "SemanticMemory":
        """자체 SQLite 연결을 명시적으로 열어 ``SemanticMemory``를 만든다.

        ``journal_mode``나 다른 연결 PRAGMA는 바꾸지 않으며, ``close()``가 이 연결을 닫는다.
        """
        if not isinstance(path, str) or not path.strip():
            raise ValueError("path must be a non-empty str")
        conn = sqlite3.connect(path)
        try:
            return cls(conn, _owns_conn=True, **kwargs)
        except BaseException:
            conn.close()
            raise

    def _ensure_schema(self) -> None:
        """부가 테이블/인덱스를 **없을 때만** 만든다. 호출자 트랜잭션은 그대로 산다.

        호출자의 롤백(또는 외부 DROP)은 이 테이블도 되돌리므로, 이 계층은 연결을 만질
        때마다 부재를 다시 확인하고 그때마다 만든다. 그래야 테이블 존재가 "누가 먼저
        이 연결을 썼는지"에 의존하지 않는다.
        """
        present = {
            (str(row[0]), str(row[1]))
            for row in self.conn.execute(
                "SELECT type, name FROM sqlite_master "
                "WHERE (type = 'table' AND name = 'semantic_vectors') "
                "OR (type = 'index' AND name = 'semantic_vectors_lookup')")
        }
        targets = (("table", "semantic_vectors"), ("index", "semantic_vectors_lookup"))
        missing = [statement for target, statement in zip(targets, DDL)
                   if target not in present]
        if not missing:
            return
        with self._tx():
            for statement in missing:
                self.conn.execute(statement)

    # ------------------------------------------------------------- capability
    def capabilities(self) -> dict[str, Any]:
        """선택된 경로와 문서화된 규칙을 그대로 노출한다(호출자가 추측하지 않게)."""
        keyword_backend = None
        capabilities = getattr(self.store, "capabilities", None)
        if callable(capabilities):
            keyword_backend = capabilities().get("backend")
        return {
            "vector_backend": "sqlite+python-cosine",
            "keyword_backend": keyword_backend,
            "keyword_available": callable(getattr(self.store, "search", None)),
            "embedding_endpoint": getattr(self.client, "base_url", None),
            "embedding_model": getattr(self.client, "model_id", None),
            "embedding_endpoint_scope": "loopback-only",
            "max_dimensions": self.max_dimensions,
            "candidate_limit": self.candidate_limit,
            "scan_limit": self.scan_limit,
            "hybrid_weights": {"vector": HYBRID_VECTOR_WEIGHT,
                               "keyword": HYBRID_KEYWORD_WEIGHT},
            "normalization": "min-max per signal over the candidate set",
            "degradation_rule": ("embedding endpoint unavailable -> keyword-only results "
                                 "labeled mode='keyword' with degraded_reason"),
        }

    @contextlib.contextmanager
    def _tx(self) -> Iterator[None]:
        """쓰기 트랜잭션. 호출자의 연결 설정(자동커밋/WAL)을 바꾸지 않는다.

        빈 연결에서는 ``BEGIN IMMEDIATE``로 시작하고, 이미 열린 트랜잭션이 있으면
        (다른 코드가 DML을 먼저 실행한 경우) 그 안에 SAVEPOINT를 걸어 중첩을 피한다.
        어느 쪽도 연결의 ``isolation_level``을 건드리지 않는다.
        """
        if self.conn.in_transaction:
            savepoint = "semantic_memory_write"
            self.conn.execute(f"SAVEPOINT {savepoint}")
            try:
                yield
                self.conn.execute(f"RELEASE {savepoint}")
            except BaseException:
                with contextlib.suppress(sqlite3.Error):
                    self.conn.execute(f"ROLLBACK TO {savepoint}")
                with contextlib.suppress(sqlite3.Error):
                    self.conn.execute(f"RELEASE {savepoint}")
                raise
            return
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.conn.execute("COMMIT")
        except BaseException:
            if self.conn.in_transaction:
                with contextlib.suppress(sqlite3.Error):
                    self.conn.execute("ROLLBACK")
            raise

    # -------------------------------------------------------------- ingestion
    def index(self, records: Sequence[Mapping[str, Any]],
              namespace: Optional[str] = None, *,
              batch_size: int = DEFAULT_BATCH_SIZE) -> dict[str, Any]:
        """레코드를 임베딩해 ``semantic_vectors``에 upsert한다. 벡터 없이는 쓰지 않는다.

        레코드는 ``{"record_id", "text", ...}`` 매핑이다(``doc_id``/``chunk_id``/``source``
        /``metadata`` 선택). 엔드포인트가 도달 불가면 예외 대신 ``status="unavailable"``과
        ``reason``을 돌려주고 아무 행도 쓰지 않는다(가짜 벡터 금지). 차원 상한 초과·차원
        불일치는 계약 위반이라 예외다.
        """
        ns = _namespace(namespace if namespace is not None else self.namespace)
        prepared = [self._prepare(record) for record in records]
        payload: dict[str, Any] = {
            "namespace": ns, "status": "indexed", "records": len(prepared), "indexed": 0,
            "embedding_model": None, "dimensions": None, "zero_vectors": 0, "reason": None,
        }
        if not prepared:
            payload["status"] = "empty"
            return payload
        if self.client is None:
            payload.update(status="unavailable", reason="no embedding client configured; "
                                                        "nothing was stored")
            return payload
        model = self._client_model()
        payload["embedding_model"] = model
        vectors: list[list[float]] = []
        try:
            size = max(int(batch_size), 1)
            for start in range(0, len(prepared), size):
                batch = prepared[start:start + size]
                vectors.extend(self._embed([record["text"] for record in batch]))
        except EmbeddingUnavailableError as exc:
            catch = dict(payload)
            catch.update(status="unavailable", indexed=0,
                         reason=f"embedding endpoint unavailable: {exc}")
            return catch
        dim = self._consistent_dimension(vectors)
        self._ensure_schema()
        self._guard_against_stored_dims(ns, model, dim)
        payload["dimensions"] = dim
        norms = [_norm(vector) for vector in vectors]
        with self._tx():
            for record, vector, norm in zip(prepared, vectors, norms):
                self.conn.execute(
                    "INSERT OR REPLACE INTO semantic_vectors (namespace, record_id, model_id, "
                    "dim, norm, vector_json, content, doc_id, chunk_id, source, metadata_json, "
                    "indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (ns, record["record_id"], model, dim, norm, json.dumps(vector),
                     record["text"], record["doc_id"], record["chunk_id"], record["source"],
                     record["metadata_json"], _now()))
        payload["indexed"] = len(prepared)
        payload["zero_vectors"] = sum(1 for norm in norms if norm == 0.0)
        return payload

    def delete(self, record_id: str, namespace: Optional[str] = None) -> dict[str, Any]:
        """한 레코드의 벡터 행을 지운다(다른 namespace는 건드리지 않는다)."""
        ns = _namespace(namespace if namespace is not None else self.namespace)
        self._ensure_schema()
        with self._tx():
            cursor = self.conn.execute(
                "DELETE FROM semantic_vectors WHERE namespace = ? AND record_id = ?",
                (ns, str(record_id)))
        return {"namespace": ns, "record_id": str(record_id), "deleted": cursor.rowcount}

    # --------------------------------------------------------------- retrieval
    def search(self, query: str, namespace: Optional[str] = None,
               k: int = 5) -> dict[str, Any]:
        """순수 벡터(코사인) 검색. 엔드포인트가 없으면 키워드로 저하하고 그 사실을 밝힌다."""
        ns, k, base = self._begin(query, namespace, k)
        if self.client is None:
            return self._keyword_degraded(base, ns, query, k,
                                         "no embedding client configured; vector search skipped")
        try:
            entries, meta = self._vector_entries(query, ns)
        except EmbeddingUnavailableError as exc:
            return self._keyword_degraded(
                base, ns, query, k, f"embedding endpoint unavailable: {exc}")
        base.update(mode="vector", embedding_model=meta["embedding_model"],
                    degraded=False, degraded_reason=None, zero_query_vector=meta["zero_query_vector"],
                    candidates_scanned=meta["candidates_scanned"], truncated=meta["truncated"],
                    vectors_available=bool(entries))
        if not entries:
            # 벡터 경로는 돌았지만 비교할 저장 벡터가 없다: 빈 결과를 "의미상 무관"으로
            # 읽지 않도록 이유를 남긴다(키워드 결과로 대체하지는 않는다: 이건 vector 검색이다).
            base["notice"] = (f"no stored vectors for namespace {ns!r} with model "
                              f"{meta['embedding_model']!r}; run index() first")
        base["results"] = [self._vector_result(entry) for entry in entries[:k]]
        return base

    def hybrid_search(self, query: str, namespace: Optional[str] = None,
                      k: int = 5) -> dict[str, Any]:
        """FTS5 키워드 점수와 코사인을 min-max 정규화 후 0.6/0.4로 합친다.

        벡터 신호가 불가하면 키워드만으로 ``mode="keyword"``(+``degraded_reason``)를
        돌려준다. 키워드 매칭이 한 건도 없으면(또는 저장소에 검색기가 없으면) 벡터만으로
        ``mode="vector"``다. 각 결과의 ``mode``/``signals``는 그 결과를 만든 신호만 가리킨다.
        """
        ns, k, base = self._begin(query, namespace, k)
        base["weights"] = {"vector": HYBRID_VECTOR_WEIGHT, "keyword": HYBRID_KEYWORD_WEIGHT}
        base["normalization"] = "min-max per signal over the candidate set"
        keywords = self._keyword_entries(query, ns, k)
        base["keyword_backend"] = self._keyword_backend()
        base["keyword_available"] = keywords is not None
        reason: Optional[str] = None
        entries: Optional[list[dict[str, Any]]] = None
        meta: dict[str, Any] = {}
        if self.client is None:
            reason = "no embedding client configured; vector signal skipped"
        else:
            try:
                entries, meta = self._vector_entries(query, ns)
            except EmbeddingUnavailableError as exc:
                reason = f"embedding endpoint unavailable: {exc}"
        base["zero_query_vector"] = meta.get("zero_query_vector", False)
        base["candidates_scanned"] = meta.get("candidates_scanned", 0)
        base["truncated"] = meta.get("truncated", False)
        if entries is not None and not entries:
            # 엔드포인트는 살아 있지만 이 namespace/model에는 비교할 벡터가 없다.
            # 하이브리드라고 부르면 의미 검색이 일어난 것처럼 보이므로 키워드로 내린다.
            reason = (f"no stored vectors for namespace {ns!r} with model "
                      f"{meta.get('embedding_model')!r}; vector signal had nothing to compare")
            entries = None
        if entries is None:
            base.update(mode="keyword", embedding_model=None, degraded=True,
                        degraded_reason=reason, vectors_available=False,
                        embedding_model_configured=getattr(self.client, "model_id", None))
            base["results"] = [] if keywords is None else [
                self._keyword_result(entry) for entry in keywords[:k]]
            return base
        base.update(embedding_model=meta["embedding_model"], degraded=False,
                    degraded_reason=None, vectors_available=True)
        if not keywords:
            # 저장소에 검색기가 없거나 키워드 매칭이 0건: 합칠 상대가 없으니 벡터 단독이다.
            base["mode"] = "vector"
            base["results"] = [self._vector_result(entry) for entry in entries[:k]]
            return base
        base["mode"] = "hybrid"
        base["results"] = self._fuse(entries, keywords, k)
        return base

    def _fuse(self, entries: Sequence[Mapping[str, Any]],
              keywords: Sequence[Mapping[str, Any]], k: int) -> list[dict[str, Any]]:
        """두 신호를 후보 집합 내 min-max 정규화 후 문서화된 가중치로 합친다."""
        dedup_keywords: list[Mapping[str, Any]] = []
        seen_keywords: set[str] = set()
        for item in keywords:
            record_id = str(item["record_id"])
            if record_id in seen_keywords:
                continue
            seen_keywords.add(record_id)
            dedup_keywords.append(item)
        vector_ids = {str(item["record_id"]) for item in entries}
        vector_norm = _minmax({str(item["record_id"]): float(item["similarity"])
                               for item in entries})
        keyword_norm = _minmax({str(item["record_id"]): float(item["keyword_score"])
                                for item in dedup_keywords})
        merged: dict[str, dict[str, Any]] = {}
        for item in entries:
            record_id = str(item["record_id"])
            merged[record_id] = dict(item, vector_score_norm=vector_norm[record_id],
                                     keyword_score_norm=0.0, signals=["vector"])
        for item in dedup_keywords:
            record_id = str(item["record_id"])
            if record_id in vector_ids:
                existing = merged[record_id]
                existing.update(keyword_score=item["keyword_score"],
                                keyword_ranks=item.get("keyword_ranks"),
                                keyword_score_norm=keyword_norm[record_id],
                                signals=["vector", "keyword"])
            else:
                merged[record_id] = dict(item, similarity=None,
                                         vector_score_norm=0.0,
                                         keyword_score_norm=keyword_norm[record_id],
                                         signals=["keyword"])
        fused = []
        for record_id, item in merged.items():
            score = (HYBRID_VECTOR_WEIGHT * item["vector_score_norm"]
                     + HYBRID_KEYWORD_WEIGHT * item["keyword_score_norm"])
            fused.append(self._result(item, score=score,
                                      mode="hybrid" if len(item["signals"]) == 2
                                      else item["signals"][0]))
        fused.sort(key=lambda item: (-item["score"], item["record_id"]))
        return fused[:k]

    def _vector_entries(self, query: str, ns: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """질의 벡터로 후보를 점수화한다. 도달 불가는 EmbeddingUnavailableError로 올린다."""
        model = self._client_model()
        query_vector = self._embed([query])[0]
        dim = len(query_vector)
        self._guard_against_stored_dims(ns, model, dim)
        terms = sorted(set(_terms(query)))
        rows, total = self._vector_candidates(ns, model, dim, terms)
        query_norm = _norm(query_vector)
        entries: list[dict[str, Any]] = []
        skipped = 0
        # 열 순서: record_id, namespace, content, vector_json, norm, doc_id, chunk_id, source
        for record_id, row_ns, content, vector_json, norm, doc_id, chunk_id, source in rows:
            stored = json.loads(vector_json)
            if len(stored) != dim:
                # dim 열과 실제 배열이 어긋난 손상 행: 절대 짝짓지 않는다.
                skipped += 1
                continue
            entries.append({
                "record_id": str(record_id), "namespace": row_ns,
                "chunk_id": chunk_id, "doc_id": doc_id, "source": source,
                "content": content, "keyword_score": None, "keyword_ranks": None,
                "similarity": _cosine(query_vector, query_norm, stored, float(norm)),
            })
        entries.sort(key=lambda item: (-item["similarity"], item["record_id"]))
        meta = {"embedding_model": model, "dimensions": dim,
                "zero_query_vector": query_norm == 0.0, "candidates_scanned": len(rows),
                "truncated": int(total) > len(rows), "skipped_malformed": skipped}
        return entries, meta

    def _vector_candidates(self, ns: str, model: str, dim: int,
                           terms: Sequence[str]) -> tuple[list[Sequence[Any]], int]:
        """SQL 단계에서 namespace·model·차원을 걸러 후보를 좁힌다(총 scan_limit 이하).

        1) 질의 토큰 LIKE 상위 집합을 ``candidate_limit``(≤scan_limit)까지 읽고,
        2) 남은 예산만큼 최근 행(rowid DESC)을 채워 의미상 겹치지 않는 질의도 회수한다.
        어느 쪽이든 메모리에 올리는 행 수는 ``scan_limit``을 넘지 않는다. 반환 행은
        위치 기반 튜플이라 호출자 연결의 ``row_factory`` 설정과 무관하다.
        """
        where = "FROM semantic_vectors WHERE namespace = ? AND model_id = ? AND dim = ?"
        columns = "record_id, namespace, content, vector_json, norm, doc_id, chunk_id, source"
        total = int(self.conn.execute(f"SELECT COUNT(*) {where}", (ns, model, dim)).fetchone()[0])
        if total == 0:
            return [], 0
        rows: list[Sequence[Any]] = []
        if terms:
            clause = " OR ".join("content LIKE ? ESCAPE '\\'" for _ in terms)
            rows = self.conn.execute(
                f"SELECT {columns} {where} AND ({clause}) ORDER BY rowid LIMIT ?",
                (ns, model, dim, *(_like(term) for term in terms),
                 min(self.candidate_limit, self.scan_limit))
            ).fetchall()
        seen = {str(row[0]) for row in rows}
        if len(rows) < self.scan_limit:
            # LIKE로 회수되지 않은(어휘가 겹치지 않는) 행도 남은 예산만큼만 최근 순으로 채운다.
            recent = self.conn.execute(
                f"SELECT {columns} {where} ORDER BY rowid DESC LIMIT ?",
                (ns, model, dim, self.scan_limit)).fetchall()
            for row in recent:
                if len(rows) >= self.scan_limit:
                    break
                record_id = str(row[0])
                if record_id in seen:
                    continue
                rows.append(row)
                seen.add(record_id)
        return rows, total

    # ------------------------------------------------------------ keyword side
    def _keyword_entries(self, query: str, ns: str,
                         k: int) -> Optional[list[dict[str, Any]]]:
        """기존 키워드 경로의 결과를 정체성 기준 레코드로 옮긴다(검색기가 없으면 None).

        지원하는 두 저장소 모두 **기존 코드를 그대로 호출**한다:

        * ``MemoryLayer.search(query, top_k, namespace)`` → RRF 점수(클수록 좋음),
          레코드 정체성 ``chunk:<chunk_id>``.
        * ``HybridContextMemoryEngine.search(query, limit, category)`` → BM25 점수
          (작을수록 좋음)라서 부호를 뒤집어 ``keyword_score``를 "클수록 좋음"으로 맞춘다.
          레코드 정체성 ``fts:<category>:<doc_id>``. 이 엔진에는 namespace가 없으므로
          namespace를 ``category``로 쓴다(격리는 그 엔진의 category 필터가 담당한다).
        """
        if isinstance(self.store, MemoryLayer):
            payload = self.store.search(query, top_k=max(k, self.candidate_limit), namespace=ns)
            entries = []
            for item in payload.get("results") or []:
                entries.append({
                    "record_id": f"chunk:{int(item['chunk_id'])}",
                    "namespace": item.get("namespace", ns), "chunk_id": int(item["chunk_id"]),
                    "doc_id": int(item["doc_id"]), "source": item.get("source"),
                    "content": item.get("content"),
                    "keyword_score": float(item["score"]),
                    "keyword_ranks": dict(item.get("ranks") or {}), "similarity": None,
                })
            return entries
        if isinstance(self.store, HybridContextMemoryEngine):
            hits = self.store.search(query, limit=max(k, self.candidate_limit), category=ns)
            entries = []
            seen: set[str] = set()
            for hit in hits:
                record_id = f"fts:{hit['category']}:{hit['doc_id']}"
                if record_id in seen:
                    continue
                seen.add(record_id)
                entries.append({
                    "record_id": record_id,
                    "namespace": hit["category"], "chunk_id": None, "doc_id": None,
                    "source": f"{hit['category']}/{hit['title']}", "content": hit["content"],
                    # bm25는 작을수록 좋으므로 부호를 뒤집어 다른 신호와 방향을 맞춘다.
                    "keyword_score": -float(hit["score"]),
                    "keyword_ranks": {"bm25": 0}, "similarity": None,
                })
            return entries
        return None

    def _keyword_backend(self) -> Optional[str]:
        capabilities = getattr(self.store, "capabilities", None)
        if callable(capabilities):
            return capabilities().get("backend")
        if isinstance(self.store, HybridContextMemoryEngine):
            return "fts5"
        return None

    def _keyword_degraded(self, base: dict[str, Any], ns: str, query: str, k: int,
                          reason: str) -> dict[str, Any]:
        keywords = self._keyword_entries(query, ns, k)
        base.update(mode="keyword", embedding_model=None, degraded=True, degraded_reason=reason,
                    keyword_backend=self._keyword_backend(),
                    keyword_available=keywords is not None, vectors_available=False,
                    embedding_model_configured=getattr(self.client, "model_id", None),
                    zero_query_vector=False, candidates_scanned=0, truncated=False)
        base["results"] = [] if keywords is None else [
            self._keyword_result(entry) for entry in keywords[:k]]
        return base

    # ---------------------------------------------------------------- shaping
    def _begin(self, query: str, namespace: Optional[str],
               k: int) -> tuple[str, int, dict[str, Any]]:
        if not isinstance(query, str):
            raise TypeError("query must be a str")
        if not isinstance(k, int) or isinstance(k, bool) or k <= 0:
            raise ValueError("k must be a positive int")
        ns = _namespace(namespace if namespace is not None else self.namespace)
        self._ensure_schema()
        base: dict[str, Any] = {"query": query, "namespace": ns, "k": k, "results": [],
                                "notice": None}
        base["capabilities"] = self.capabilities()
        return ns, k, base

    @staticmethod
    def _result(entry: Mapping[str, Any], *, score: float, mode: str) -> dict[str, Any]:
        return {
            "record_id": entry["record_id"], "namespace": entry["namespace"],
            "chunk_id": entry.get("chunk_id"), "doc_id": entry.get("doc_id"),
            "source": entry.get("source"), "content": entry.get("content"),
            "score": score, "mode": mode, "signals": list(entry.get("signals") or [mode]),
            "similarity": entry.get("similarity"),
            "keyword_score": entry.get("keyword_score"),
            "keyword_ranks": entry.get("keyword_ranks"),
            "vector_score_norm": entry.get("vector_score_norm"),
            "keyword_score_norm": entry.get("keyword_score_norm"),
        }

    def _vector_result(self, entry: Mapping[str, Any]) -> dict[str, Any]:
        return self._result(entry, score=float(entry["similarity"]), mode="vector")

    def _keyword_result(self, entry: Mapping[str, Any]) -> dict[str, Any]:
        return self._result(entry, score=float(entry["keyword_score"]), mode="keyword")

    # --------------------------------------------------------------- internals
    def _client_model(self) -> str:
        if self.client is None:
            raise SemanticMemoryError("no embedding client configured")
        model = getattr(self.client, "model_id", None)
        if not isinstance(model, str) or not model.strip():
            raise EmbeddingError("embedding client must expose a non-empty 'model_id'")
        return model.strip()

    def _embed(self, texts: Sequence[str]) -> list[list[float]]:
        """클라이언트 호출 + 계약 검증(개수/유한성/차원 상한/빈 벡터)."""
        if self.client is None:
            raise SemanticMemoryError("no embedding client configured")
        try:
            raw = self.client.embed(list(texts))
        except SemanticMemoryError:
            raise
        except Exception as exc:  # 주입 클라이언트의 임의 실패 = 도달 불가로 취급(가짜 벡터 금지)
            raise EmbeddingUnavailableError(f"embedding client failed: {exc}") from exc
        try:
            vectors = [[float(value) for value in vector] for vector in raw]
        except (TypeError, ValueError) as exc:
            raise EmbeddingResponseError(
                f"embeddings must be sequences of numbers: {exc}") from exc
        if len(vectors) != len(texts):
            raise EmbeddingResponseError(
                f"expected {len(texts)} embeddings, got {len(vectors)}")
        for vector in vectors:
            if not vector:
                raise EmbeddingResponseError("embedding vector must not be empty")
            if len(vector) > self.max_dimensions:
                raise DimensionCapExceededError(
                    f"embedding has {len(vector)} dimensions, cap is {self.max_dimensions}")
            for value in vector:
                if not math.isfinite(value):
                    raise EmbeddingResponseError("embedding contains a non-finite value")
        return vectors

    def _consistent_dimension(self, vectors: Sequence[Sequence[float]]) -> int:
        dims = {len(vector) for vector in vectors}
        if len(dims) != 1:
            raise DimensionMismatchError(f"embeddings in one index() call disagree on "
                                        f"dimensions: {sorted(dims)}")
        return dims.pop()

    def _guard_against_stored_dims(self, ns: str, model: str, dim: int) -> None:
        stored = {int(row[0]) for row in self.conn.execute(
            "SELECT DISTINCT dim FROM semantic_vectors WHERE namespace = ? AND model_id = ?",
            (ns, model))}
        if stored and dim not in stored:
            raise DimensionMismatchError(
                f"embedding dimension {dim} does not match stored dimensions {sorted(stored)} "
                f"for model {model!r} in namespace {ns!r}")

    @staticmethod
    def _prepare(record: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(record, Mapping):
            raise TypeError("record must be a mapping with 'record_id' and 'text'")
        record_id = record.get("record_id")
        text = record.get("text")
        if not isinstance(record_id, str) or not record_id.strip():
            raise ValueError("record_id must be a non-empty str")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"text must be a non-empty str (record {record_id!r})")
        metadata = record.get("metadata") or {}
        if not isinstance(metadata, Mapping):
            raise ValueError(f"metadata must be a mapping (record {record_id!r})")
        source = record.get("source")
        return {"record_id": record_id.strip(), "text": text,
                "doc_id": _opt_int(record.get("doc_id")),
                "chunk_id": _opt_int(record.get("chunk_id")),
                "source": source if isinstance(source, str) else None,
                "metadata_json": json.dumps(dict(metadata), ensure_ascii=False, sort_keys=True)}

    # ------------------------------------------------------------- inspection
    def stats(self, namespace: Optional[str] = None) -> dict[str, Any]:
        """벡터 행 수/차원/모델. 기본은 이 인스턴스(또는 지정) namespace만 센다."""
        ns = _namespace(namespace if namespace is not None else self.namespace)
        self._ensure_schema()
        vectors = int(self.conn.execute(
            "SELECT COUNT(*) FROM semantic_vectors WHERE namespace = ?", (ns,)).fetchone()[0])
        dims = [int(row[0]) for row in self.conn.execute(
            "SELECT DISTINCT dim FROM semantic_vectors WHERE namespace = ? ORDER BY dim", (ns,))]
        models = [str(row[0]) for row in self.conn.execute(
            "SELECT DISTINCT model_id FROM semantic_vectors WHERE namespace = ? "
            "ORDER BY model_id", (ns,))]
        return {"scope": "namespace", "namespace": ns, "vectors": vectors,
                "dimensions": dims, "models": models,
                "keyword_backend": self._keyword_backend()}

    def close(self) -> None:
        """이 인스턴스가 연 연결만 닫는다(넘겨받은 layer/connection은 그대로 둔다)."""
        if self._owns_conn:
            self.conn.close()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
