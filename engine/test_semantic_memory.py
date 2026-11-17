"""semantic_memory 테스트: 루프백 가짜 엔드포인트 + 주입 클라이언트만 사용한다.

실제 모델/네트워크는 쓰지 않는다. ``FakeEmbeddingServer``는 ``127.0.0.1:0``(임시 포트)에
올라가고, 응답 ``data`` 배열의 순서를 일부러 뒤집어 ``index`` 짝짓기 검증까지 한다.
다운 엔드포인트는 **실제로 닫힌 loopback 포트**라서 연결 거부가 진짜로 발생한다.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import socket
import sqlite3
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from engine.fts5_memory import HybridContextMemoryEngine
from engine.memory_layer import MemoryLayer
from engine.semantic_memory import (
    DEFAULT_BASE_URL,
    DEFAULT_MODEL_ID,
    HYBRID_KEYWORD_WEIGHT,
    HYBRID_VECTOR_WEIGHT,
    DimensionCapExceededError,
    DimensionMismatchError,
    EmbeddingError,
    EmbeddingResponseError,
    EmbeddingUnavailableError,
    LocalOpenAIEmbeddingClient,
    NonLoopbackEndpointError,
    SemanticMemory,
    ensure_loopback_base_url,
    records_from_fts5_engine,
    records_from_memory_layer,
)


def fake_vector(text: str, dim: int = 4) -> list[float]:
    """결정론적 가짜 임베딩: 바이트 값을 버킷에 누적한다(0 벡터가 되지 않는다)."""
    vector = [0.0] * dim
    for offset, byte in enumerate(text.encode("utf-8")):
        vector[offset % dim] += float((byte % 13) + 1)
    return vector


class ScriptedClient:
    """텍스트→벡터 표를 그대로 돌려주는 주입 클라이언트. 표에 없으면 조용히 넘어가지 않는다."""

    model_id = "scripted-1"

    def __init__(self, table: dict[str, list[float]], model_id: str = "scripted-1") -> None:
        self.table = {key: list(value) for key, value in table.items()}
        self.model_id = model_id
        self.calls: list[list[str]] = []

    def embed(self, texts):
        self.calls.append(list(texts))
        vectors = []
        for text in texts:
            if text not in self.table:
                raise EmbeddingError(f"unexpected text in scripted client: {text!r}")
            vectors.append(list(self.table[text]))
        return vectors


class ComputedClient:
    """함수 기반 주입 클라이언트(차원 변동 시나리오용)."""

    def __init__(self, function, model_id: str = "scripted-1") -> None:
        self.function, self.model_id = function, model_id

    def embed(self, texts):
        return [self.function(text) for text in texts]


class DeadClient:
    """도달 불가를 흉내내는 클라이언트(비-loopback 경로 없이 저하 규칙만 검증)."""

    model_id = "dead-1"

    def embed(self, texts):
        raise OSError("connection refused by fake upstream")


class FakeEmbeddingServer:
    """loopback OpenAI 호환 ``/v1/embeddings`` 스텁. ``data`` 순서를 뒤집어 보낸다."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - stdlib 이름 규약
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw.decode("utf-8"))
            server = self.server
            server.requests.append((self.path, body))
            if server.fail_status:
                self.send_response(server.fail_status)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            data = [{"object": "embedding", "index": index,
                     "embedding": fake_vector(text, server.dimensions)}
                    for index, text in enumerate(body.get("input") or [])]
            data.reverse()
            payload = json.dumps({"model": body.get("model"), "data": data}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args) -> None:  # 테스트 출력을 조용히 유지한다.
            return

    def __init__(self, dimensions: int = 4, fail_status: int = 0) -> None:
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), self.Handler)
        self.httpd.requests = []
        self.httpd.dimensions = dimensions
        self.httpd.fail_status = fail_status
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def port(self) -> int:
        return int(self.httpd.server_address[1])

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def requests(self):
        return self.httpd.requests

    def __enter__(self) -> "FakeEmbeddingServer":
        self.thread.start()
        return self

    def __exit__(self, *exc_info) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)


def closed_loopback_url() -> str:
    """바인딩했다가 즉시 닫은 loopback 포트: 연결 거부가 확실한 다운 엔드포인트."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = int(sock.getsockname()[1])
    sock.close()
    return f"http://127.0.0.1:{port}"


def record(record_id: str, text: str, **extra) -> dict:
    payload = {"record_id": record_id, "text": text}
    payload.update(extra)
    return payload


def open_memory(case: unittest.TestCase, **kwargs) -> SemanticMemory:
    """``SemanticMemory``를 만들고(문자열 경로면 ``SemanticMemory.open``) 테스트 종료 시 닫는다."""
    store = kwargs.pop("store")
    if isinstance(store, str):
        memory = SemanticMemory.open(store, **kwargs)
    else:
        memory = SemanticMemory(store, **kwargs)
    case.addCleanup(memory.close)
    return memory


class LoopbackEndpointTests(unittest.TestCase):
    def test_default_base_url_matches_the_local_embedding_server(self) -> None:
        from engine.embedding_server import DEFAULT_HOST, DEFAULT_PORT, HASH_MODEL_ID

        self.assertEqual(DEFAULT_BASE_URL, f"http://{DEFAULT_HOST}:{DEFAULT_PORT}")
        self.assertTrue(DEFAULT_BASE_URL.startswith("http://127.0.0.1"))
        self.assertEqual(DEFAULT_MODEL_ID, HASH_MODEL_ID)
        self.assertEqual(ensure_loopback_base_url("http://localhost:11434"), "http://localhost:11434")
        self.assertEqual(ensure_loopback_base_url("http://[::1]:8080/"), "http://[::1]:8080")

    def test_base_url_with_api_root_normalizes_to_one_endpoint(self) -> None:
        # 관행대로 /v1을 붙여 넘겨도 요청 경로는 단 하나(/v1/embeddings)여야 한다.
        for base_url in ("http://127.0.0.1:8099", "http://127.0.0.1:8099/",
                         "http://127.0.0.1:8099/v1", "http://127.0.0.1:8099/v1/"):
            with self.subTest(base_url=base_url):
                client = LocalOpenAIEmbeddingClient(base_url=base_url)
                self.assertEqual(client.endpoint, "http://127.0.0.1:8099/v1/embeddings")

    def test_non_loopback_base_url_is_refused_with_clear_error(self) -> None:
        for base_url in ("http://10.1.2.3:8080", "http://example.com/v1", "http://0.0.0.0:8080",
                         "https://api.openai.com/v1"):
            with self.subTest(base_url=base_url):
                with self.assertRaises(NonLoopbackEndpointError) as caught:
                    LocalOpenAIEmbeddingClient(base_url=base_url)
                self.assertIn("not a loopback", str(caught.exception))
                with self.assertRaises(NonLoopbackEndpointError):
                    SemanticMemory.open(":memory:", base_url=base_url)

    def test_redirect_or_non_loopback_resolution_is_refused_without_following_it(self) -> None:
        redirect_targets: list[str] = []

        class RedirectHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                target = "http://10.255.255.1:9999/v1/embeddings"
                redirect_targets.append(target)
                self.send_response(302)
                self.send_header("Location", target)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args) -> None:
                return

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (httpd.shutdown(), httpd.server_close(), thread.join(5)))
        client = LocalOpenAIEmbeddingClient(
            base_url=f"http://127.0.0.1:{httpd.server_address[1]}",
            model="fake-embed",
            timeout=2.0,
        )
        with self.assertRaises(EmbeddingUnavailableError) as caught:
            client.embed(["alpha"])
        self.assertIn("302", str(caught.exception))
        self.assertEqual(redirect_targets, ["http://10.255.255.1:9999/v1/embeddings"])

        # DNS가 비-루프백 주소를 돌려주면 연결 시도조차 하지 않고 거부한다.
        original_getaddrinfo = socket.getaddrinfo
        try:
            socket.getaddrinfo = lambda *args, **kwargs: [  # type: ignore[assignment]
                (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("10.1.2.3", 8099))
            ]
            with self.assertRaises(NonLoopbackEndpointError):
                LocalOpenAIEmbeddingClient(base_url="http://localhost:8099").embed(["alpha"])
        finally:
            socket.getaddrinfo = original_getaddrinfo

    def test_missing_or_duplicate_response_indices_are_rejected(self) -> None:
        bodies = [
            # 역순 응답에서 index가 모두 빠진 경우(위치로 추측하면 잘못된 벡터와 짝지어진다)
            {"model": "fake-embed", "data": [
                {"object": "embedding", "embedding": fake_vector("beta")},
                {"object": "embedding", "embedding": fake_vector("alpha")},
            ]},
            # 중복 index
            {"model": "fake-embed", "data": [
                {"object": "embedding", "index": 0, "embedding": fake_vector("alpha")},
                {"object": "embedding", "index": 0, "embedding": fake_vector("beta")},
            ]},
            # 불리언 index(int의 서브클래스지만 정수 인덱스가 아니다)
            {"model": "fake-embed", "data": [
                {"object": "embedding", "index": True, "embedding": fake_vector("alpha")},
                {"object": "embedding", "index": 0, "embedding": fake_vector("beta")},
            ]},
        ]
        for response_body in bodies:
            with self.subTest(data=response_body["data"]):
                payload = json.dumps(response_body).encode("utf-8")

                class BadIndexHandler(BaseHTTPRequestHandler):
                    def do_POST(self) -> None:  # noqa: N802
                        length = int(self.headers.get("Content-Length") or 0)
                        if length:
                            self.rfile.read(length)
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(payload)))
                        self.end_headers()
                        self.wfile.write(payload)

                    def log_message(self, *args) -> None:
                        return

                httpd = ThreadingHTTPServer(("127.0.0.1", 0), BadIndexHandler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                try:
                    memory = open_memory(
                        self,
                        store=":memory:",
                        namespace="team",
                        base_url=f"http://127.0.0.1:{httpd.server_address[1]}",
                        model="fake-embed",
                    )
                    with self.assertRaises(EmbeddingResponseError) as caught:
                        memory.index([record("doc-1", "alpha"), record("doc-2", "beta")])
                    self.assertIn("index", str(caught.exception))
                    self.assertEqual(memory.stats()["vectors"], 0)
                finally:
                    httpd.shutdown()
                    httpd.server_close()
                    thread.join(5)

    def test_response_model_mismatch_is_rejected_and_never_stored_under_configured_id(self) -> None:
        payloads = [
            # 응답이 다른 모델을 밝히는 경우
            json.dumps({"model": "actual-other-model", "data": [
                {"object": "embedding", "index": 0, "embedding": fake_vector("alpha")}]}),
            # 응답이 모델 신원을 아예 밝히지 않는 경우(설정 id로 대신 보고하지 않는다)
            json.dumps({"data": [
                {"object": "embedding", "index": 0, "embedding": fake_vector("alpha")}]}),
        ]
        for served in payloads:
            with self.subTest(served=served):
                payload = served.encode("utf-8")

                class WrongModelHandler(BaseHTTPRequestHandler):
                    def do_POST(self) -> None:  # noqa: N802
                        length = int(self.headers.get("Content-Length") or 0)
                        if length:
                            self.rfile.read(length)
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(payload)))
                        self.end_headers()
                        self.wfile.write(payload)

                    def log_message(self, *args) -> None:
                        return

                httpd = ThreadingHTTPServer(("127.0.0.1", 0), WrongModelHandler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                try:
                    memory = open_memory(
                        self,
                        store=":memory:",
                        namespace="team",
                        base_url=f"http://127.0.0.1:{httpd.server_address[1]}",
                        model="configured-model",
                    )
                    with self.assertRaises(EmbeddingResponseError) as caught:
                        memory.index([record("doc-1", "alpha")])
                    self.assertIn("configured-model", str(caught.exception))
                    self.assertEqual(memory.stats()["vectors"], 0)
                finally:
                    httpd.shutdown()
                    httpd.server_close()
                    thread.join(5)

    def test_client_sends_openai_shape_and_pairs_vectors_by_index(self) -> None:
        with FakeEmbeddingServer() as server:
            client = LocalOpenAIEmbeddingClient(base_url=server.base_url, model="fake-embed")
            vectors = client.embed(["alpha", "beta", "gamma"])
            self.assertEqual(vectors, [fake_vector("alpha"), fake_vector("beta"),
                                       fake_vector("gamma")])
            path, body = server.requests[0]
            self.assertEqual(path, "/v1/embeddings")
            self.assertEqual(body["model"], "fake-embed")
            self.assertEqual(body["input"], ["alpha", "beta", "gamma"])

    def test_live_endpoint_index_and_search_report_vector_mode(self) -> None:
        with FakeEmbeddingServer() as server:
            memory = open_memory(self, store=":memory:", namespace="team",
                                 base_url=server.base_url, model="fake-embed")
            result = memory.index([record("doc-1", "the runner retries a failed build"),
                                   record("doc-2", "the cache keeps planner artifacts"),
                                   record("doc-3", "the dag schedules nightly nodes")])
            self.assertEqual(result["status"], "indexed")
            self.assertEqual(result["indexed"], 3)
            self.assertEqual(result["embedding_model"], "fake-embed")
            self.assertEqual(result["dimensions"], 4)

            payload = memory.search("the runner retries a failed build", k=2)
            self.assertEqual(payload["mode"], "vector")
            self.assertEqual(payload["embedding_model"], "fake-embed")
            self.assertFalse(payload["degraded"])
            self.assertEqual(len(payload["results"]), 2)
            self.assertEqual(payload["results"][0]["record_id"], "doc-1")
            self.assertAlmostEqual(payload["results"][0]["score"], 1.0, places=9)
            self.assertEqual(payload["results"][0]["mode"], "vector")

    def test_http_error_status_degrades_instead_of_faking_vectors(self) -> None:
        with FakeEmbeddingServer(fail_status=503) as server:
            memory = open_memory(self, store=":memory:", namespace="team",
                                 base_url=server.base_url)
            result = memory.index([record("doc-1", "anything")])
            self.assertEqual(result["status"], "unavailable")
            self.assertEqual(result["indexed"], 0)
            self.assertIn("503", result["reason"])
            self.assertEqual(memory.stats()["vectors"], 0)


class VectorSearchTests(unittest.TestCase):
    """손으로 계산한 코사인 기대값(1.0, 1/√2, 0.0)으로 순위·동점 규칙을 고정한다."""

    TABLE = {
        "red apple": [1.0, 0.0],
        "alpha": [1.0, 0.0],
        "beta": [1.0, 1.0],
        "gamma": [0.0, 1.0],
        "delta": [0.0, 2.0],
        "echo": [0.0, 2.0],
    }

    def setUp(self) -> None:
        self.client = ScriptedClient(self.TABLE)
        self.memory = open_memory(self, store=":memory:", namespace="user-a",
                                  client=self.client)

    def test_cosine_ranking_and_deterministic_tie(self) -> None:
        result = self.memory.index([record("r-b", "beta"), record("r-a", "alpha"),
                                    record("r-c", "gamma"), record("r-d", "delta"),
                                    record("r-e", "echo")])
        self.assertEqual(result["indexed"], 5)

        payload = self.memory.search("red apple", k=5)
        self.assertEqual(payload["mode"], "vector")
        self.assertEqual([item["record_id"] for item in payload["results"]],
                         ["r-a", "r-b", "r-c", "r-d", "r-e"])
        # |[1,0]·[1,0]| / (1*1) = 1.0
        self.assertAlmostEqual(payload["results"][0]["similarity"], 1.0, places=12)
        # 1 / √2
        self.assertAlmostEqual(payload["results"][1]["similarity"], 1 / math.sqrt(2), places=12)
        # gamma/delta/echo는 모두 직교 → 0.0, 동점은 record_id 오름차순
        for item in payload["results"][2:]:
            self.assertAlmostEqual(item["similarity"], 0.0, places=12)
        self.assertLess(payload["results"][2]["record_id"], payload["results"][3]["record_id"])
        # 정렬은 (유사도 내림차순, record_id 오름차순)로 결정적이다.
        self.assertEqual([item["score"] for item in payload["results"]],
                         sorted((item["score"] for item in payload["results"]), reverse=True))

    def test_k_is_respected_in_vector_and_hybrid_paths(self) -> None:
        self.memory.index([record(f"r-{index}", text) for index, text in
                           enumerate(["alpha", "beta", "gamma", "delta", "echo"])])
        self.assertEqual(len(self.memory.search("red apple", k=2)["results"]), 2)
        self.assertEqual(len(self.memory.hybrid_search("red apple", k=1)["results"]), 1)
        self.assertEqual(len(self.memory.search("red apple", k=9)["results"]), 5)
        for bad_k in (0, -1):
            with self.assertRaises(ValueError):
                self.memory.search("red apple", k=bad_k)

    def test_zero_vectors_never_produce_nan(self) -> None:
        client = ComputedClient(lambda text: [0.0, 0.0] if text == "zero" else [1.0, 1.0],
                                model_id="scripted-1")
        memory = open_memory(self, store=":memory:", namespace="user-a", client=client)
        memory.index([record("r-zero", "zero"), record("r-live", "live")])

        # 0인 저장 벡터: 나눗셈 없이 0.0
        payload = memory.search("query", k=5)
        scores = {item["record_id"]: item["score"] for item in payload["results"]}
        self.assertEqual(scores["r-zero"], 0.0)
        self.assertAlmostEqual(scores["r-live"], 1.0, places=12)
        self.assertTrue(all(math.isfinite(item["score"]) for item in payload["results"]))

        # 0인 질의 벡터: 나눗셈 없이 0.0, 그리고 그 사실을 플래그로 알린다.
        zero_query = memory.search("zero", k=5)
        self.assertTrue(zero_query["zero_query_vector"])
        self.assertEqual([item["score"] for item in zero_query["results"]], [0.0, 0.0])
        self.assertTrue(all(math.isfinite(item["score"]) for item in zero_query["results"]))

    def test_extreme_finite_vectors_compute_accurate_cosine_without_overflow_or_underflow(self) -> None:
        table = {
            "huge-pos": [1e308, 0.0],
            "huge-neg": [-1e308, 0.0],
            "tiny": [1e-200, 0.0],
        }
        memory = open_memory(self, store=":memory:", namespace="user-a",
                             client=ScriptedClient(table))
        memory.index([
            record("r-huge-neg", "huge-neg"),
            record("r-tiny", "tiny"),
        ])

        huge = memory.search("huge-pos", k=5)
        self.assertFalse(huge["zero_query_vector"])
        huge_scores = {item["record_id"]: item["similarity"] for item in huge["results"]}
        self.assertAlmostEqual(huge_scores["r-huge-neg"], -1.0, places=12)

        tiny = memory.search("tiny", k=5)
        self.assertFalse(tiny["zero_query_vector"])
        tiny_scores = {item["record_id"]: item["similarity"] for item in tiny["results"]}
        self.assertAlmostEqual(tiny_scores["r-tiny"], 1.0, places=12)

    def test_dimension_mismatch_is_rejected(self) -> None:
        client = ComputedClient(
            lambda text: [1.0, 0.0, 0.0] if text == "a" else [1.0, 0.0, 0.0, 0.0],
            model_id="scripted-1")
        memory = open_memory(self, store=":memory:", namespace="user-a", client=client)
        with self.assertRaises(DimensionMismatchError) as caught:
            memory.index([record("r-a", "a"), record("r-b", "b")])
        self.assertIn("dimensions", str(caught.exception))
        self.assertEqual(memory.stats()["vectors"], 0)

        # 저장된 차원과 다른 임베딩(같은 namespace/model)도 거부한다.
        stored = open_memory(self, store=":memory:", namespace="user-a",
                             client=ComputedClient(lambda text: [1.0, 2.0, 3.0],
                                                   model_id="scripted-1"))
        stored.index([record("r-a", "a")])
        other = open_memory(self, store=stored.conn, namespace="user-a",
                            client=ComputedClient(lambda text: [1.0, 2.0, 3.0, 4.0],
                                                  model_id="scripted-1"))
        with self.assertRaises(DimensionMismatchError) as caught:
            other.index([record("r-c", "c")])
        self.assertIn("stored dimensions", str(caught.exception))
        self.assertEqual(stored.stats()["vectors"], 1)

    def test_query_dimension_drift_raises_dimension_mismatch_error(self) -> None:
        vectors = {
            "stored-2d": [1.0, 0.0],
            "query-3d": [1.0, 0.0, 0.0],
        }
        layer = MemoryLayer(":memory:", namespace="user-a")
        self.addCleanup(layer.close)
        layer.add_document("stored-2d", "doc.md")
        memory = SemanticMemory(layer, namespace="user-a",
                                client=ComputedClient(lambda text: vectors[text],
                                                      model_id="scripted-1"))
        memory.index([record("r-2d", "stored-2d")])
        with self.assertRaises(DimensionMismatchError) as caught:
            memory.search("query-3d", k=3)
        self.assertIn("stored dimensions", str(caught.exception))
        with self.assertRaises(DimensionMismatchError):
            memory.hybrid_search("query-3d", k=3)

    def test_dimension_cap_is_enforced(self) -> None:
        client = ComputedClient(lambda text: [1.0] * 8, model_id="scripted-1")
        memory = open_memory(self, store=":memory:", namespace="user-a", client=client,
                             max_dimensions=4)
        with self.assertRaises(DimensionCapExceededError) as caught:
            memory.index([record("r-a", "a")])
        self.assertIn("cap is 4", str(caught.exception))
        self.assertEqual(memory.stats()["vectors"], 0)

    def test_injected_client_receives_batched_texts(self) -> None:
        self.memory.index([record(f"r-{index}", text) for index, text in
                           enumerate(["alpha", "beta", "gamma"])], batch_size=2)
        self.assertEqual(self.client.calls, [["alpha", "beta"], ["gamma"]])

    def test_unknown_text_in_scripted_client_surfaces_as_embedding_error(self) -> None:
        with self.assertRaises(EmbeddingError):
            self.memory.search("not in table", k=1)


class NamespaceIsolationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = sqlite3.connect(":memory:")
        self.store.isolation_level = None
        self.addCleanup(self.store.close)
        self.alice = SemanticMemory(self.store, namespace="alice",
                                    client=ComputedClient(fake_vector))
        self.bob = SemanticMemory(self.store, namespace="bob",
                                  client=ComputedClient(fake_vector))

    def test_namespace_isolation_holds_both_ways(self) -> None:
        self.alice.index([record("shared-id", "alice private retry ledger")])
        self.bob.index([record("shared-id", "bob private cache ledger")])

        alice_hits = self.alice.search("alice private retry ledger", k=5)["results"]
        bob_hits = self.bob.search("bob private cache ledger", k=5)["results"]

        self.assertEqual([item["record_id"] for item in alice_hits], ["shared-id"])
        self.assertEqual({item["namespace"] for item in alice_hits}, {"alice"})
        self.assertEqual([item["record_id"] for item in bob_hits], ["shared-id"])
        self.assertEqual({item["namespace"] for item in bob_hits}, {"bob"})
        self.assertEqual(self.alice.search("alice private retry ledger")["results"][0]["content"],
                         "alice private retry ledger")

        # 명시적 namespace로도 남의 namespace를 섞어 읽을 수 없다(단일 namespace 결과).
        crossed = self.alice.search("bob private cache ledger", namespace="bob", k=5)
        self.assertEqual({item["namespace"] for item in crossed["results"]}, {"bob"})
        self.assertEqual(self.alice.stats()["vectors"], 1)
        self.assertEqual(self.bob.stats()["vectors"], 1)


class InterleavedWriteTests(unittest.TestCase):
    """파일 DB(WAL)에서 두 namespace가 번갈아 써도 서로의 후보로 새지 않아야 한다."""

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmp, "semantic.sqlite3")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_interleaved_writes_do_not_leak_across_namespaces(self) -> None:
        alice = SemanticMemory.open(self.db_path, namespace="alice",
                                    client=ComputedClient(fake_vector))
        bob = SemanticMemory.open(self.db_path, namespace="bob",
                                  client=ComputedClient(fake_vector))
        self.addCleanup(alice.close)
        self.addCleanup(bob.close)

        alice.index([record("a-1", "alice cache notes")])
        bob.index([record("b-1", "bob cache notes")])
        alice.index([record("a-2", "alice runner ledger")])
        bob.index([record("b-2", "bob runner ledger")])
        alice.delete("a-1")
        bob.index([record("b-3", "bob cache ledger again")])

        alice_hits = alice.search("bob cache notes", k=10)["results"]
        bob_hits = bob.search("alice cache notes", k=10)["results"]
        self.assertEqual({item["namespace"] for item in alice_hits}, {"alice"})
        self.assertEqual({item["namespace"] for item in bob_hits}, {"bob"})
        self.assertEqual({item["record_id"] for item in alice_hits}, {"a-2"})
        self.assertEqual({item["record_id"] for item in bob_hits}, {"b-1", "b-2", "b-3"})
        self.assertEqual(alice.stats()["vectors"], 1)
        self.assertEqual(bob.stats()["vectors"], 3)
        # 공용 테이블 하나에 두 namespace가 함께 있다(격리는 SQL WHERE 절이 담당한다).
        total = alice.conn.execute("SELECT COUNT(*) FROM semantic_vectors").fetchone()[0]
        self.assertEqual(int(total), 4)


class HybridSearchTests(unittest.TestCase):
    """문서화된 가중치(벡터 0.6 / 키워드 0.4, 신호별 min-max)를 실제 점수로 확인한다."""

    TEXTS = {
        "cache.md": "cache eviction keeps the planner artifact around",
        "runner.md": "the runner retries a failed build twice",
        "dag.md": "the dag schedules nightly nodes",
    }
    QUERY = "cache eviction"

    def setUp(self) -> None:
        self.layer = MemoryLayer(":memory:", namespace="team")
        self.addCleanup(self.layer.close)
        for source, text in self.TEXTS.items():
            self.layer.add_document(text, source)
        self.records = records_from_memory_layer(self.layer, "team")
        self.by_source = {item["source"]: item for item in self.records}
        self.ids = {source: item["record_id"] for source, item in self.by_source.items()}
        # 질의 벡터 [1,0] 기준: cache.md는 직교(0.0), runner.md는 0.995, dag.md는 0.7071.
        self.table = {text: [0.2, 1.0] for text in self.TEXTS.values()}
        self.table[self.TEXTS["cache.md"]] = [0.2, 1.0]
        self.table[self.TEXTS["runner.md"]] = [1.0, 0.1]
        self.table[self.TEXTS["dag.md"]] = [0.5, 0.5]
        self.table[self.QUERY] = [1.0, 0.0]
        self.memory = SemanticMemory(self.layer, namespace="team",
                                     client=ScriptedClient(self.table))

    def test_records_from_memory_layer_share_chunk_identity(self) -> None:
        self.assertEqual(len(self.records), 3)
        chunk_ids = [int(row[0]) for row in self.layer.conn.execute(
            "SELECT chunk_id FROM chunks WHERE namespace = 'team' ORDER BY chunk_id")]
        self.assertEqual([item["record_id"] for item in self.records],
                         [f"chunk:{chunk_id}" for chunk_id in chunk_ids])
        keyword_ids = {f"chunk:{hit['chunk_id']}"
                       for hit in self.layer.search(self.QUERY, top_k=5)["results"]}
        self.assertTrue(keyword_ids)
        # 키워드 결과의 정체성이 벡터 레코드 정체성과 같아야 하이브리드 융합이 합쳐진다.
        self.assertLessEqual(keyword_ids, {item["record_id"] for item in self.records})
        self.assertEqual(self.layer.stats()["chunks"], 3)
        # 변환은 읽기 전용이다: 문서/청크 수가 그대로다.
        self.assertEqual(self.layer.stats()["documents"], 3)

    def test_hybrid_combines_scores_with_documented_weights(self) -> None:
        self.assertEqual(self.memory.index(self.records)["indexed"], 3)
        payload = self.memory.hybrid_search(self.QUERY, k=5)

        self.assertEqual(payload["mode"], "hybrid")
        self.assertEqual(payload["weights"], {"vector": 0.6, "keyword": 0.4})
        self.assertEqual((HYBRID_VECTOR_WEIGHT, HYBRID_KEYWORD_WEIGHT), (0.6, 0.4))
        self.assertFalse(payload["degraded"])
        self.assertIsNone(payload["degraded_reason"])
        self.assertEqual(payload["embedding_model"], "scripted-1")

        # 후보 전체가 결과에 있으므로 보고된 신호 값만으로 공식을 재계산할 수 있다.
        similarities = {item["record_id"]: item["similarity"]
                        for item in payload["results"] if item["similarity"] is not None}
        keywords = {item["record_id"]: item["keyword_score"]
                    for item in payload["results"] if item["keyword_score"] is not None}
        self.assertEqual(set(keywords), {self.ids["cache.md"]})

        def normalize(values: dict) -> dict:
            low, high = min(values.values()), max(values.values())
            if high == low:
                return {key: 1.0 for key in values}
            return {key: (value - low) / (high - low) for key, value in values.items()}

        vec_norm, kw_norm = normalize(similarities), normalize(keywords)
        for item in payload["results"]:
            record_id = item["record_id"]
            expected = (HYBRID_VECTOR_WEIGHT * vec_norm.get(record_id, 0.0)
                        + HYBRID_KEYWORD_WEIGHT * kw_norm.get(record_id, 0.0))
            self.assertAlmostEqual(item["score"], expected, places=12)
            self.assertEqual(item["mode"], "hybrid" if record_id in keywords else "vector")

        # 키워드만 보면 cache.md가 1위지만, 0.6 벡터 가중치가 runner.md를 앞세운다.
        keyword_only = SemanticMemory(self.layer, namespace="team", client=None)
        keyword_payload = keyword_only.hybrid_search(self.QUERY, k=5)
        self.assertEqual(keyword_payload["mode"], "keyword")
        self.assertEqual(keyword_payload["results"][0]["record_id"], self.ids["cache.md"])

        self.assertEqual(payload["results"][0]["record_id"], self.ids["runner.md"])
        self.assertAlmostEqual(payload["results"][0]["score"], 0.6, places=12)
        self.assertAlmostEqual(
            {item["record_id"]: item["score"] for item in payload["results"]}[
                self.ids["cache.md"]], 0.4, places=12)

    def test_hybrid_degrades_to_keyword_when_endpoint_is_down(self) -> None:
        memory = SemanticMemory(self.layer, namespace="team", base_url=closed_loopback_url(),
                                timeout=2.0)
        indexed = memory.index(self.records)
        self.assertEqual(indexed["status"], "unavailable")
        self.assertIn("unavailable", indexed["reason"])
        self.assertEqual(memory.stats()["vectors"], 0)

        payload = memory.hybrid_search(self.QUERY, k=5)
        self.assertEqual(payload["mode"], "keyword")
        self.assertTrue(payload["degraded"])
        self.assertIsNone(payload["embedding_model"])
        self.assertEqual(payload["embedding_model_configured"], DEFAULT_MODEL_ID)
        self.assertIn("embedding endpoint unavailable", payload["degraded_reason"])
        self.assertTrue(payload["results"])
        self.assertEqual({item["mode"] for item in payload["results"]}, {"keyword"})
        self.assertEqual({item["signals"][0] for item in payload["results"]}, {"keyword"})
        for item in payload["results"]:
            self.assertIsNone(item["similarity"])
            self.assertIsNotNone(item["keyword_score"])
        # 저하는 라벨일 뿐 아니라 순위도 키워드 순위 그대로다.
        self.assertEqual(payload["results"][0]["record_id"], self.ids["cache.md"])

    def test_vector_search_before_indexing_explains_the_empty_result(self) -> None:
        payload = self.memory.search(self.QUERY, k=3)
        self.assertEqual(payload["mode"], "vector")
        self.assertEqual(payload["results"], [])
        self.assertFalse(payload["vectors_available"])
        self.assertIn("run index() first", payload["notice"])
        self.assertIsNone(payload["degraded_reason"])

    def test_hybrid_reports_keyword_when_no_vectors_are_stored(self) -> None:
        # 엔드포인트는 살아 있지만 색인 전이라 비교할 벡터가 없다: "하이브리드"로 부르지 않는다.
        payload = self.memory.hybrid_search(self.QUERY, k=5)
        self.assertEqual(payload["mode"], "keyword")
        self.assertTrue(payload["degraded"])
        self.assertFalse(payload["vectors_available"])
        self.assertIn("no stored vectors", payload["degraded_reason"])
        self.assertIn("scripted-1", payload["degraded_reason"])
        self.assertIsNone(payload["embedding_model"])
        self.assertEqual(payload["embedding_model_configured"], "scripted-1")
        self.assertEqual([item["mode"] for item in payload["results"]], ["keyword"])

    def test_hybrid_reports_vector_when_keyword_finds_nothing(self) -> None:
        self.memory.client.table["kubernetes"] = [0.9, 0.1]
        self.memory.index(self.records)
        payload = self.memory.hybrid_search("kubernetes", k=3)
        # 어휘 매칭 0건이므로 합칠 상대가 없다: 벡터 단독이라고 밝힌다.
        self.assertEqual(payload["mode"], "vector")
        self.assertTrue(payload["results"])
        self.assertEqual(payload["embedding_model"], "scripted-1")
        self.assertEqual({item["mode"] for item in payload["results"]}, {"vector"})
        self.assertIsNone(payload["results"][0]["keyword_score"])
        self.assertEqual(payload["results"][0]["record_id"], self.ids["runner.md"])

    def test_search_degrades_to_keyword_with_reason(self) -> None:
        memory = SemanticMemory(self.layer, namespace="team", base_url=closed_loopback_url(),
                                timeout=2.0)
        payload = memory.search(self.QUERY, k=3)
        self.assertEqual(payload["mode"], "keyword")
        self.assertTrue(payload["degraded"])
        self.assertIn("embedding endpoint unavailable", payload["degraded_reason"])
        self.assertEqual(self.layer.stats()["chunks"], 3)

    def test_unreachable_injected_client_also_degrades(self) -> None:
        memory = SemanticMemory(self.layer, namespace="team", client=DeadClient())
        payload = memory.hybrid_search(self.QUERY, k=3)
        self.assertEqual(payload["mode"], "keyword")
        self.assertTrue(payload["degraded"])
        self.assertIn("connection refused", payload["degraded_reason"])
        self.assertIn("embedding client failed", payload["degraded_reason"])
        self.assertIsNone(payload["embedding_model"])
        # 주입 클라이언트의 임의 실패는 index()에서도 가짜 벡터 없이 unavailable로 처리된다.
        indexed = memory.index(self.records)
        self.assertEqual(indexed["status"], "unavailable")
        self.assertEqual(indexed["indexed"], 0)
        self.assertIn("connection refused", indexed["reason"])
        self.assertIn("embedding client failed", indexed["reason"])
        self.assertEqual(memory.stats()["vectors"], 0)


class PlumbingTests(unittest.TestCase):
    def test_capabilities_and_stats_are_truthful(self) -> None:
        layer = MemoryLayer(":memory:", namespace="team")
        self.addCleanup(layer.close)
        memory = SemanticMemory(layer, namespace="team", client=ComputedClient(fake_vector))
        capabilities = memory.capabilities()
        self.assertEqual(capabilities["embedding_endpoint_scope"], "loopback-only")
        self.assertEqual(capabilities["embedding_model"], "scripted-1")
        self.assertEqual(capabilities["max_dimensions"], 4096)
        self.assertEqual(capabilities["hybrid_weights"], {"vector": 0.6, "keyword": 0.4})
        self.assertIn("keyword-only", capabilities["degradation_rule"])

        memory.index([record("r-1", "alpha"), record("r-2", "beta")])
        self.assertEqual(memory.stats()["vectors"], 2)
        self.assertEqual(memory.stats()["dimensions"], [4])
        self.assertEqual(memory.stats()["models"], ["scripted-1"])
        self.assertEqual(memory.delete("r-1")["deleted"], 1)
        self.assertEqual(memory.stats()["vectors"], 1)

    def test_no_client_means_keyword_only_and_nothing_stored(self) -> None:
        layer = MemoryLayer(":memory:", namespace="team")
        self.addCleanup(layer.close)
        layer.add_document("cache eviction keeps artifacts", "cache.md")
        memory = SemanticMemory(layer, namespace="team", client=None)

        result = memory.index(records_from_memory_layer(layer, "team"))
        self.assertEqual(result["status"], "unavailable")
        self.assertIn("no embedding client", result["reason"])
        payload = memory.hybrid_search("cache eviction", k=3)
        self.assertEqual(payload["mode"], "keyword")
        self.assertTrue(payload["degraded"])
        self.assertTrue(payload["results"])

    def test_bounded_candidates_flag_truncation(self) -> None:
        memory = open_memory(self, store=":memory:", namespace="team",
                             client=ComputedClient(fake_vector),
                             candidate_limit=2, scan_limit=3)
        memory.index([record(f"r-{index}", f"cache note {index}") for index in range(6)])
        payload = memory.search("cache note", k=6)
        self.assertEqual(payload["candidates_scanned"], 3)
        self.assertTrue(payload["truncated"])
        self.assertEqual(len(payload["results"]), 3)

    def test_caller_connection_settings_are_not_modified(self) -> None:
        conn = sqlite3.connect(":memory:")   # 기본 row_factory(tuple) + 기본 isolation_level
        self.addCleanup(conn.close)
        before = (conn.row_factory, conn.isolation_level)
        memory = open_memory(self, store=conn, namespace="team",
                             client=ComputedClient(fake_vector))
        self.assertEqual((conn.row_factory, conn.isolation_level), before)
        memory.index([record("r-1", "alpha"), record("r-2", "beta")])
        self.assertEqual([item["record_id"] for item in memory.search("alpha", k=1)["results"]],
                         ["r-1"])
        self.assertFalse(conn.in_transaction)
        # 쓰기는 커밋되어 같은 연결의 다른 소비자에게도 보인다(경쟁 writer를 만들지 않는다).
        self.assertEqual(int(conn.execute(
            "SELECT COUNT(*) FROM semantic_vectors").fetchone()[0]), 2)

    def test_vector_table_is_additive_and_leaves_memory_layer_schema_alone(self) -> None:
        layer = MemoryLayer(":memory:", namespace="team")
        self.addCleanup(layer.close)
        layer.add_document("cache eviction keeps artifacts", "cache.md")
        before = {row[0] for row in layer.conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'")}
        open_memory(self, store=layer, namespace="team", client=ComputedClient(fake_vector))
        after = {row[0] for row in layer.conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'")}
        self.assertEqual(after - before, {"semantic_vectors"})
        columns = {row[1] for row in layer.conn.execute("PRAGMA table_info(chunks)")}
        self.assertEqual(columns, {"chunk_id", "doc_id", "namespace", "ordinal", "content",
                                   "char_start", "char_end", "embedding_json"})

    def test_construction_preserves_caller_open_transaction_so_rollback_undoes_insert(self) -> None:
        conn = sqlite3.connect(":memory:")
        self.addCleanup(conn.close)
        conn.execute("CREATE TABLE caller_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
        conn.execute("INSERT INTO caller_items (name) VALUES ('pending-row')")
        self.assertTrue(conn.in_transaction)

        memory = SemanticMemory(conn, namespace="team", client=ComputedClient(fake_vector))
        self.assertTrue(conn.in_transaction)
        conn.rollback()

        remaining = conn.execute("SELECT COUNT(*) FROM caller_items").fetchone()[0]
        self.assertEqual(int(remaining), 0)
        # 롤백은 이 계층의 테이블도 함께 되돌린다(경계를 넘지 않는다): 같은 인스턴스가
        # 다음 쓰기에서 테이블을 다시 만들어야 한다(생성 시점 상태에 의존하지 않는다).
        memory.index([record("r-1", "alpha")])
        self.assertEqual(memory.stats()["vectors"], 1)
        # 다른 소비자가 테이블을 지운 뒤에도(연결이 이전 상태를 기억하지 않는다) 다시 만든다.
        conn.execute("DROP TABLE semantic_vectors")
        self.assertEqual(memory.stats()["vectors"], 0)
        memory.index([record("r-2", "beta")])
        self.assertEqual(memory.stats()["vectors"], 1)
        conn.execute("INSERT INTO caller_items (name) VALUES ('second-pending-row')")
        self.assertTrue(conn.in_transaction)
        SemanticMemory(conn, namespace="team", client=ComputedClient(fake_vector))
        self.assertTrue(conn.in_transaction)
        conn.rollback()
        self.assertEqual(
            int(conn.execute("SELECT COUNT(*) FROM caller_items").fetchone()[0]),
            0,
        )

    def test_failed_commit_rolls_back_and_leaves_no_open_transaction(self) -> None:
        conn = sqlite3.connect(":memory:", isolation_level=None)
        self.addCleanup(conn.close)
        memory = SemanticMemory(conn, namespace="team", client=ComputedClient(fake_vector))

        def deny_commit(action: int, arg1, arg2, dbname, source) -> int:
            if action == sqlite3.SQLITE_TRANSACTION and arg1 == "COMMIT":
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK

        conn.set_authorizer(deny_commit)
        try:
            with self.assertRaises(sqlite3.DatabaseError):
                memory.index([record("r-1", "alpha")])
        finally:
            conn.set_authorizer(None)

        self.assertFalse(conn.in_transaction)
        self.assertEqual(memory.stats()["vectors"], 0)

    def test_path_string_constructor_is_refused_and_open_preserves_journal_mode(self) -> None:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        db_path = os.path.join(tmp, "existing.sqlite3")
        conn = sqlite3.connect(db_path)
        try:
            mode_before = str(conn.execute("PRAGMA journal_mode = DELETE").fetchone()[0]).lower()
            self.assertEqual(mode_before, "delete")
        finally:
            conn.close()

        with self.assertRaises(TypeError) as caught:
            SemanticMemory(db_path, namespace="team", client=ComputedClient(fake_vector))
        self.assertIn("SemanticMemory.open", str(caught.exception))

        explicit = SemanticMemory.open(db_path, namespace="team",
                                       client=ComputedClient(fake_vector))
        try:
            mode_after = str(explicit.conn.execute("PRAGMA journal_mode").fetchone()[0]).lower()
            self.assertEqual(mode_after, "delete")
        finally:
            explicit.close()


class Fts5EngineIntegrationTests(unittest.TestCase):
    """``HybridContextMemoryEngine``(namespace 대신 category)와의 접합.

    그 엔진에는 namespace 열이 없으므로 이 계층은 category를 namespace로 쓴다. 격리는
    벡터 테이블의 namespace 열과 그 엔진의 ``category`` 필터가 함께 담당한다.
    """

    TEXTS = {
        "ops": ("retry", "runner retries", "the runner retries a failed build twice"),
        "docs": ("cache", "cache eviction", "cache eviction drops planner artifacts"),
    }

    def setUp(self) -> None:
        self.engine = HybridContextMemoryEngine(":memory:")
        self.addCleanup(self.engine.close)
        for category, (title, _slug, content) in self.TEXTS.items():
            self.engine.index_document(category, title, content)
        # doc_id는 엔진이 본문 해시로 만든다: 정체성은 그 값을 그대로 이어받아야 한다.
        self.ids = {category: f"fts:{category}:{self.engine.search(slug, limit=1, category=category)[0]['doc_id']}"
                    for category, (_title, slug, _content) in self.TEXTS.items()}
        self.table = {content: fake_vector(content)
                      for _title, _slug, content in self.TEXTS.values()}
        self.table["retries"] = fake_vector("the runner retries a failed build twice")
        self.table["retry"] = fake_vector("the runner retries a failed build twice")
        self.table["cache"] = fake_vector("cache eviction drops planner artifacts")
        self.memory = open_memory(self, store=self.engine, namespace="ops",
                                  client=ScriptedClient(self.table))

    def test_each_category_is_indexed_and_searchable_in_isolation(self) -> None:
        ops = records_from_fts5_engine(self.engine, "ops")
        docs = records_from_fts5_engine(self.engine, "docs")
        self.assertEqual([item["record_id"] for item in ops], [self.ids["ops"]])
        self.assertEqual([item["record_id"] for item in docs], [self.ids["docs"]])
        self.assertEqual(self.memory.index(ops)["indexed"], 1)
        self.assertEqual(self.memory.index(docs, namespace="docs")["indexed"], 1)

        ops_hits = self.memory.search("retry", namespace="ops", k=5)["results"]
        docs_hits = self.memory.search("retry", namespace="docs", k=5)["results"]
        self.assertEqual({item["record_id"] for item in ops_hits}, {self.ids["ops"]})
        self.assertEqual({item["record_id"] for item in docs_hits}, {self.ids["docs"]})
        self.assertEqual({item["namespace"] for item in ops_hits}, {"ops"})
        self.assertEqual({item["namespace"] for item in docs_hits}, {"docs"})

    def test_hybrid_uses_category_scoped_bm25_as_keyword_signal(self) -> None:
        self.memory.index(records_from_fts5_engine(self.engine, "ops"))
        payload = self.memory.hybrid_search("retries", namespace="ops", k=5)
        self.assertEqual(payload["mode"], "hybrid")
        self.assertEqual(payload["keyword_backend"], "fts5")
        self.assertEqual(payload["embedding_model"], "scripted-1")
        top = payload["results"][0]
        self.assertEqual(top["record_id"], self.ids["ops"])
        self.assertEqual(top["signals"], ["vector", "keyword"])
        # bm25는 작을수록 좋으므로 부호를 뒤집어 "클수록 좋음"으로 정렬되어야 한다.
        self.assertGreater(top["keyword_score"], 0.0)
        self.assertAlmostEqual(top["score"], 1.0, places=12)

    def test_keyword_only_when_no_client_and_category_still_scoped(self) -> None:
        self.memory.index(records_from_fts5_engine(self.engine, "ops"))
        bare = open_memory(self, store=self.engine, namespace="ops", client=None)
        payload = bare.hybrid_search("retries", namespace="ops", k=5)
        self.assertEqual(payload["mode"], "keyword")
        self.assertTrue(payload["degraded"])
        self.assertEqual([item["record_id"] for item in payload["results"]],
                         [self.ids["ops"]])
        self.assertEqual(bare.stats("docs")["vectors"], 0)

    def test_duplicate_fts_document_without_vector_never_fabricates_vector_or_hybrid_signal(self) -> None:
        # 같은 FTS 문서를 두 번 색인하고, 벡터는 다른 문서에만 저장한다.
        dup_title, dup_content = "cache-dup", "runner retries cache eviction twice"
        self.engine.index_document("ops", dup_title, dup_content)
        self.engine.index_document("ops", dup_title, dup_content)
        dup_hits = [hit for hit in self.engine.search("retries", limit=10, category="ops")
                    if hit["title"] == dup_title]
        self.assertEqual(len(dup_hits), 2)
        dup_record_id = f"fts:ops:{dup_hits[0]['doc_id']}"

        # 벡터는 원래 ops 문서 하나만 저장하고, 중복 색인된 문서는 벡터를 저장하지 않는다.
        only_vector_record = [item for item in records_from_fts5_engine(self.engine, "ops")
                              if item["record_id"] == self.ids["ops"]]
        self.assertEqual(self.memory.index(only_vector_record)["indexed"], 1)

        payload = self.memory.hybrid_search("retries", namespace="ops", k=10)
        by_id = {item["record_id"]: item for item in payload["results"]}
        self.assertEqual(len(payload["results"]), 2)
        self.assertIn(dup_record_id, by_id)
        dup_item = by_id[dup_record_id]
        self.assertEqual(dup_item["mode"], "keyword")
        self.assertEqual(dup_item["signals"], ["keyword"])
        self.assertIsNone(dup_item["similarity"])
        self.assertEqual(dup_item["vector_score_norm"], 0.0)


class RepoEmbeddingServerIntegrationTests(unittest.TestCase):
    """이 저장소의 실제 ``embedding_server``에 붙여 배선을 확인한다(루프백, 다운로드 없음).

    기본 백엔드 ``HashBackend``는 **합성 토큰 해시** 벡터라 의미 유사도를 주장하지 않는다.
    여기서 검증하는 것은 프로토콜/모델 id 일치/격리 같은 배선이며, 응답이 그 사실을
    숨기지 않는지(모델 id를 그대로 결과에 싣는지)까지 본다.
    """

    def setUp(self) -> None:
        from engine.embedding_server import HASH_MODEL_ID, create_server

        server = create_server(host="127.0.0.1", port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join(10)))
        self.base_url = server.base_url()
        self.model_id = HASH_MODEL_ID
        self.memory = open_memory(self, store=":memory:", namespace="team",
                                  base_url=self.base_url, model=HASH_MODEL_ID, timeout=10.0)

    def test_index_and_hybrid_search_against_the_shipped_server(self) -> None:
        indexed = self.memory.index([record("doc-1", "the runner retries a failed build twice"),
                                     record("doc-2", "cache eviction drops planner artifacts")])
        self.assertEqual(indexed["status"], "indexed")
        self.assertEqual(indexed["embedding_model"], self.model_id)
        self.assertGreater(indexed["dimensions"], 0)

        payload = self.memory.search("runner retries a failed build", k=2)
        self.assertEqual(payload["mode"], "vector")
        self.assertEqual(payload["results"][0]["record_id"], "doc-1")
        self.assertEqual(payload["embedding_model"], self.model_id)

    def test_wrong_model_id_is_a_server_error_and_degrades(self) -> None:
        # HashBackend는 자기가 광고한 이름만 받는다(404) → 가짜 벡터 없이 저하.
        memory = open_memory(self, store=":memory:", namespace="team",
                             base_url=self.base_url, model="some/other-model", timeout=10.0)
        indexed = memory.index([record("doc-1", "anything")])
        self.assertEqual(indexed["status"], "unavailable")
        self.assertIn("404", indexed["reason"])
        self.assertIn("some/other-model", indexed["reason"])
        self.assertEqual(memory.stats()["vectors"], 0)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
