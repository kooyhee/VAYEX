"""embedding_server 테스트: OpenAI 호환 형태, 진실성 고지, 한도/오류, 백엔드 계약.

모든 서버는 ephemeral 루프백 포트에만 바인드한다. 네트워크는 루프백 밖으로 나가지 않고,
모델 다운로드/GPU/외부 호출은 없다. 원격 백엔드 검증도 127.0.0.1 스텁 서버를 쓴다.
"""
from __future__ import annotations

import errno
import json
import re
import socket
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Mapping, Optional, Tuple

from engine.embedding_server import (
    DEFAULT_MAX_BATCH_TEXTS,
    HASH_MODEL_ID,
    BackendError,
    BindAddressFamilyError,
    EmbeddingBatchResult,
    HashBackend,
    LocalModelBackend,
    LocalModelUnavailableError,
    NonLoopbackBindError,
    NonLoopbackEndpointError,
    RemoteBackend,
    RemoteBackendError,
    describe_backend,
    describe_cost,
    is_loopback_host,
    is_loopback_literal,
    select_backend,
)

LEXICAL = re.compile(r"[A-Za-z0-9_가-힣]+")


def read_http_response(sock: socket.socket) -> Tuple[int, Dict[str, str], bytes]:
    """소켓에서 HTTP 응답 1건을 읽는다(Content-Length 로 본문을 자른다)."""
    buffer = b""
    while b"\r\n\r\n" not in buffer:
        chunk = sock.recv(4096)
        if not chunk:
            raise AssertionError(f"connection closed before headers: {buffer!r}")
        buffer += chunk
    head, _, body = buffer.partition(b"\r\n\r\n")
    lines = head.split(b"\r\n")
    status = int(lines[0].split(b" ")[1])
    headers: Dict[str, str] = {}
    for line in lines[1:]:
        key, _, value = line.decode("latin-1").partition(":")
        headers[key.strip().lower()] = value.strip()
    expected = int(headers.get("content-length", "0"))
    while len(body) < expected:
        chunk = sock.recv(65536)
        if not chunk:
            break
        body += chunk
    return status, headers, body[:expected]


def raw_socket_exchange(port: int, request: bytes, timeout: float = 10.0) -> Tuple[int, Dict[str, str], bytes]:
    """Content-Length 로 응답을 잘라 읽는다(소켓 EOF 에 의존하지 않는 최소 파서)."""
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as sock:
        sock.sendall(request)
        return read_http_response(sock)


class _Client:
    """프록시 환경변수를 무시하는 최소 JSON 클라이언트(루프백 전용)."""

    def __init__(self, base_url: str):
        self.base_url = base_url
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def raw(self, method: str, path: str, body: Optional[bytes] = None,
            headers: Optional[Mapping[str, str]] = None,
            timeout: float = 10.0) -> Tuple[int, Dict[str, str], bytes]:
        request = urllib.request.Request(
            f"{self.base_url}{path}", data=body, method=method,
            headers=dict(headers or {}),
        )
        try:
            with self._opener.open(request, timeout=timeout) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, dict(exc.headers or {}), exc.read()
            finally:
                exc.close()

    def json(self, method: str, path: str, payload: Any = None,
             raw_body: Optional[bytes] = None,
             headers: Optional[Mapping[str, str]] = None) -> Tuple[int, Any]:
        body = raw_body if raw_body is not None else (
            None if payload is None else json.dumps(payload).encode("utf-8")
        )
        merged = {"Content-Type": "application/json"} if body is not None else {}
        merged.update(headers or {})
        status, _, raw = self.raw(method, path, body, merged)
        try:
            return status, json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):  # pragma: no cover - 진단용
            return status, {"_raw": raw.decode("utf-8", "replace")}


class ServerCase(unittest.TestCase):
    """ephemeral 루프백 서버를 띄우고 정리하는 베이스."""

    server = None  # type: Any

    def _serve_threads(self) -> Dict[int, threading.Thread]:
        registry = getattr(self, "_serve_thread_registry", None)
        if registry is None:
            registry = {}
            self._serve_thread_registry = registry
        return registry

    def start_server(self, backend=None, **kwargs):
        from engine.embedding_server import create_server

        server = create_server(backend, host="127.0.0.1", port=0, **kwargs)
        thread = threading.Thread(target=server.serve_forever, name="embedding-test", daemon=True)
        thread.start()
        self._serve_threads()[id(server)] = thread
        self.addCleanup(self.stop_server, server)
        self.server = server
        return server, _Client(server.base_url())

    def stop_server(self, server) -> None:
        """**멱등** 정리: 서버를 내리고 ``serve_forever`` 스레드를 join 한다.

        테스트 중간 정지와 ``addCleanup`` 이 같은 서버에 두 번 걸려도 안전해야 하고,
        정지 뒤 남은 serve 스레드가 없어야 스레드 수 집계가 의미를 갖는다.
        """
        thread = self._serve_threads().pop(id(server), None)
        if not getattr(server, "_test_stopped", False):
            server._test_stopped = True
            server.shutdown()
        server.server_close()
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=10.0)


class EmbeddingShapeTests(ServerCase):
    def setUp(self) -> None:
        self.backend = HashBackend(dimensions=16)
        server, self.client = self.start_server(self.backend)
        self.base_url = server.base_url()

    def test_single_string_matches_openai_shape_exactly(self) -> None:
        status, body = self.client.json("POST", "/v1/embeddings",
                                       {"model": HASH_MODEL_ID, "input": "retry the failed build"})

        self.assertEqual(status, 200)
        self.assertEqual(set(body), {"object", "data", "model", "usage"})
        self.assertEqual(body["object"], "list")
        self.assertEqual(body["model"], HASH_MODEL_ID)
        self.assertEqual(set(body["usage"]), {"prompt_tokens", "total_tokens"})
        self.assertEqual(len(body["data"]), 1)
        entry = body["data"][0]
        self.assertEqual(set(entry), {"object", "index", "embedding"})
        self.assertEqual(entry["object"], "embedding")
        self.assertEqual(entry["index"], 0)
        self.assertEqual(len(entry["embedding"]), 16)
        self.assertTrue(all(isinstance(value, float) for value in entry["embedding"]))
        expected_tokens = len(LEXICAL.findall("retry the failed build"))
        self.assertEqual(body["usage"]["prompt_tokens"], expected_tokens)
        self.assertEqual(body["usage"]["total_tokens"], expected_tokens)

    def test_list_input_preserves_order_and_indexes(self) -> None:
        texts = ["alpha beta", "gamma", "the runner retries a failed build"]
        status, body = self.client.json("POST", "/v1/embeddings",
                                       {"model": HASH_MODEL_ID, "input": texts})

        self.assertEqual(status, 200)
        self.assertEqual([entry["index"] for entry in body["data"]], [0, 1, 2])
        self.assertEqual(len(body["data"]), len(texts))
        expected_tokens = sum(len(LEXICAL.findall(text)) for text in texts)
        self.assertEqual(body["usage"]["prompt_tokens"], expected_tokens)
        self.assertEqual({len(entry["embedding"]) for entry in body["data"]}, {16})
        # 순서 보존: 같은 텍스트를 단일 호출로 넣은 벡터와 목록 안의 벡터가 일치한다.
        _, single = self.client.json("POST", "/v1/embeddings",
                                     {"model": HASH_MODEL_ID, "input": texts[1]})
        self.assertEqual(single["data"][0]["embedding"], body["data"][1]["embedding"])

    def test_dimensions_stay_consistent_and_deterministic(self) -> None:
        first = self.backend.embed_batch(["deterministic vector"]).vectors[0]
        second = self.backend.embed_batch(["deterministic vector"]).vectors[0]

        self.assertEqual(first, second)
        self.assertEqual(len(first), self.backend.dimensions)
        _status, body = self.client.json("POST", "/v1/embeddings",
                                        {"model": HASH_MODEL_ID, "input": ["a", "b", "c"]})
        widths = {len(entry["embedding"]) for entry in body["data"]}
        self.assertEqual(widths, {self.backend.dimensions})
        _status, again = self.client.json("POST", "/v1/embeddings",
                                         {"model": HASH_MODEL_ID, "input": "a"})
        self.assertEqual(again["data"][0]["embedding"], body["data"][0]["embedding"])
        # 서로 다른 텍스트는 다른 벡터를 만든다(해시 충돌 없는 한).
        self.assertNotEqual(body["data"][0]["embedding"], body["data"][1]["embedding"])

    def test_vectors_are_unit_length_or_zero(self) -> None:
        vectors = self.backend.embed_batch(["alpha beta gamma", "!!! ???"]).vectors
        for vector in vectors:
            norm = sum(value * value for value in vector)
            self.assertTrue(abs(norm) < 1e-9 or abs(norm - 1.0) < 1e-6)


class LimitAndErrorTests(ServerCase):
    def setUp(self) -> None:
        self.backend = HashBackend(dimensions=8)
        server, self.client = self.start_server(self.backend, max_body_bytes=4096,
                                                max_batch_texts=3)
        self.port = server.server_address[1]

    def _post_raw(self, payload: bytes, headers: Mapping[str, str]) -> Tuple[int, Any]:
        return self.client.json("POST", "/v1/embeddings", raw_body=payload, headers=headers)

    def test_malformed_bodies_are_rejected_with_400(self) -> None:
        cases = {
            "not json": b"{not json",
            "json array": b'["input"]',
            "missing model": json.dumps({"input": "x"}).encode(),
            "blank model": json.dumps({"model": "  ", "input": "x"}).encode(),
            "missing input": json.dumps({"model": HASH_MODEL_ID}).encode(),
            "numeric input": json.dumps({"model": HASH_MODEL_ID, "input": 7}).encode(),
            "empty list": json.dumps({"model": HASH_MODEL_ID, "input": []}).encode(),
            "non-string element": json.dumps(
                {"model": HASH_MODEL_ID, "input": ["ok", 5]}).encode(),
            "blank text": json.dumps({"model": HASH_MODEL_ID, "input": "   "}).encode(),
            "not utf8": b'{"model": "' + HASH_MODEL_ID.encode() + b'", "input": "\xff\xfe"}',
        }
        for label, payload in cases.items():
            with self.subTest(case=label):
                status, body = self._post_raw(payload, {"Content-Type": "application/json"})
                self.assertEqual(status, 400, body)
                self.assertEqual(body["error"]["type"], "invalid_request_error")
                self.assertIsInstance(body["error"]["message"], str)
                self.assertTrue(body["error"]["message"])

    def test_oversized_body_is_rejected_with_400(self) -> None:
        oversized = json.dumps({"model": HASH_MODEL_ID, "input": "x" * 8192}).encode()
        self.assertGreater(len(oversized), 4096)

        status, body = self._post_raw(oversized, {"Content-Type": "application/json"})

        self.assertEqual(status, 400, body)
        self.assertEqual(body["error"]["code"], "request_too_large")
        self.assertIn("4096", body["error"]["message"])

    def test_missing_content_length_is_rejected_with_400(self) -> None:
        status, headers, body = raw_socket_exchange(
            self.port,
            b"POST /v1/embeddings HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            b"Content-Type: application/json\r\n\r\n",
        )

        self.assertEqual(status, 400)
        self.assertEqual(headers["connection"].lower(), "close")
        self.assertEqual(json.loads(body.decode("utf-8"))["error"]["code"],
                         "missing_content_length")

    def test_batch_limit_is_enforced(self) -> None:
        status, body = self.client.json(
            "POST", "/v1/embeddings",
            {"model": HASH_MODEL_ID, "input": ["a", "b", "c", "d"]})

        self.assertEqual(status, 400, body)
        self.assertEqual(body["error"]["code"], "batch_too_large")
        self.assertIn("3", body["error"]["message"])
        # 한도 안쪽 배치는 그대로 통과한다.
        ok_status, ok_body = self.client.json(
            "POST", "/v1/embeddings", {"model": HASH_MODEL_ID, "input": ["a", "b", "c"]})
        self.assertEqual(ok_status, 200, ok_body)
        self.assertEqual(len(ok_body["data"]), 3)

    def test_unknown_model_is_404_and_names_it(self) -> None:
        status, body = self.client.json("POST", "/v1/embeddings",
                                       {"model": "openai/text-embedding-3-large", "input": "x"})

        self.assertEqual(status, 404, body)
        self.assertEqual(body["error"]["code"], "model_not_found")
        self.assertIn("openai/text-embedding-3-large", body["error"]["message"])
        self.assertIn(HASH_MODEL_ID, body["error"]["message"])

    def test_unknown_path_and_wrong_method(self) -> None:
        status, body = self.client.json("GET", "/v1/unknown")
        self.assertEqual(status, 404, body)
        self.assertEqual(body["error"]["code"], "unknown_path")

        status, body = self.client.json("GET", "/v1/embeddings")
        self.assertEqual(status, 405, body)
        self.assertEqual(body["error"]["code"], "method_not_allowed")


class DisclosureTests(ServerCase):
    def setUp(self) -> None:
        self.backend = HashBackend(dimensions=8)
        self.server, self.client = self.start_server(self.backend)

    def test_healthz_discloses_synthetic_backend_and_no_auth(self) -> None:
        status, headers, raw = self.client.raw("GET", "/healthz")
        body = json.loads(raw.decode("utf-8"))

        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["backend"]["backend"], "HashBackend")
        self.assertTrue(body["backend"]["synthetic"])
        self.assertIn("NOT semantic", body["backend"]["note"])
        self.assertEqual(body["backend"]["dimensions"], 8)
        self.assertTrue(body["bind"]["loopback"])
        self.assertEqual(body["bind"]["host"], "127.0.0.1")
        self.assertEqual(body["limits"]["max_batch_texts"], DEFAULT_MAX_BATCH_TEXTS)
        self.assertIn("unauthenticated", body["authentication"])
        self.assertTrue(body["cost"]["free"])
        self.assertEqual(body["cost"]["usd_per_request"], 0.0)
        # 응답 헤더도 같은 사실을 반복해 알린다.
        lowered = {key.lower(): value for key, value in headers.items()}
        self.assertEqual(lowered["x-embedding-synthetic"], "true")
        self.assertEqual(lowered["x-embedding-free"], "true")
        self.assertEqual(lowered["x-embedding-cost-usd"], "0")
        self.assertEqual(lowered["x-embedding-backend"], "HashBackend")

    def test_v1_models_discloses_synthetic_backend(self) -> None:
        status, body = self.client.json("GET", "/v1/models")

        self.assertEqual(status, 200)
        self.assertEqual(body["object"], "list")
        self.assertEqual(len(body["data"]), 1)
        entry = body["data"][0]
        self.assertEqual(entry["id"], HASH_MODEL_ID)
        self.assertEqual(entry["object"], "model")
        self.assertTrue(entry["synthetic"])
        self.assertEqual(entry["dimensions"], 8)
        self.assertIn("NOT semantic", entry["note"])
        self.assertTrue(body["backend"]["synthetic"])
        self.assertTrue(body["cost"]["free"])
        self.assertIn("unauthenticated", body["authentication"])

    def test_stats_counts_requests_and_texts(self) -> None:
        self.client.json("POST", "/v1/embeddings", {"model": HASH_MODEL_ID, "input": ["a", "b"]})
        self.client.json("POST", "/v1/embeddings", {"model": HASH_MODEL_ID, "input": "c"})
        self.client.json("POST", "/v1/embeddings", {"model": "nope", "input": "c"})

        status, body = self.client.json("GET", "/stats")

        self.assertEqual(status, 200)
        self.assertEqual(body["requests"]["embeddings"], 2)
        self.assertEqual(body["texts"]["embedded"], 3)
        self.assertEqual(body["requests"]["failed"], 1)
        self.assertEqual(body["tokens"]["counted"], 3)
        self.assertGreaterEqual(body["requests"]["total"], 4)
        self.assertGreater(body["bytes_received"], 0)
        self.assertTrue(body["cost"]["free"])


class BindAndBackendGuardTests(unittest.TestCase):
    def test_non_loopback_bind_is_refused_without_the_explicit_flag(self) -> None:
        from engine.embedding_server import create_server

        for host in ("0.0.0.0", "192.168.0.10", "example.com", ""):
            with self.subTest(host=host):
                with self.assertRaises(NonLoopbackBindError) as context:
                    create_server(HashBackend(), host=host, port=0)
                self.assertIn("allow_non_loopback", str(context.exception))

    def test_server_class_itself_refuses_a_non_loopback_bind(self) -> None:
        # create_server() 를 거치지 않은 직접 생성도 같은 가드를 통과해야 한다.
        from engine.embedding_server import EmbeddingHTTPServer

        for host in ("0.0.0.0", "10.1.2.3", "example.com"):
            with self.subTest(host=host):
                with self.assertRaises(NonLoopbackBindError) as context:
                    EmbeddingHTTPServer((host, 0), HashBackend())
                self.assertIn("allow_non_loopback", str(context.exception))

    def test_explicit_non_loopback_flag_logs_an_off_device_warning(self) -> None:
        # TEST-NET-1 주소는 이 호스트에 없으므로 bind는 실패하지만, 경고는 그 전에 남는다.
        # 실제로 비루프백 인터페이스에 포트를 열지 않고 경고 경로만 검증한다.
        from engine.embedding_server import LOGGER, create_server

        with self.assertLogs(LOGGER, level="WARNING") as captured:
            with self.assertRaises(OSError):
                create_server(HashBackend(), host="192.0.2.1", port=0, allow_non_loopback=True)
        joined = " ".join(captured.output)
        self.assertIn("192.0.2.1", joined)
        self.assertIn("off-device", joined)
        self.assertIn("unauthenticated", joined)

    def test_cli_flag_not_environment_variable_authorizes_off_device_binding(self) -> None:
        import os
        from unittest.mock import patch

        from engine.embedding_server import create_server, main

        with patch.dict(os.environ, {"HARNESS_EMBEDDING_ALLOW_NON_LOOPBACK": "1"}):
            # 환경변수만으로는 비루프백 바인드가 허용되지 않는다(명시적 플래그 전용).
            with self.assertRaises(NonLoopbackBindError):
                create_server(HashBackend(), host="192.168.0.10", port=0)
            # CLI 경로도 환경변수를 승인 근거로 쓰지 않는다: 시작이 거부되어 exit 2.
            with patch("engine.embedding_server.select_backend", return_value=HashBackend()):
                with self.assertLogs("engine.embedding_server", level="ERROR") as captured:
                    self.assertEqual(main(["--host", "192.168.0.10", "--port", "0"]), 2)
        self.assertIn("cannot start embedding server", " ".join(captured.output))

    def test_loopback_hostname_is_resolved_and_pinned(self) -> None:
        from unittest.mock import patch

        from engine.embedding_server import resolve_loopback_address

        def fake_resolver(host, port, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("203.0.113.7", 0))]

        with patch("engine.embedding_server.socket.getaddrinfo", side_effect=fake_resolver):
            with self.assertRaises(NonLoopbackEndpointError) as context:
                resolve_loopback_address("localhost", "bind address")
            self.assertIn("203.0.113.7", str(context.exception))
            self.assertIn("non-loopback", str(context.exception))
            # 바인드 경로도 같은 해석 결과로 거부된다.
            with self.assertRaises(NonLoopbackBindError):
                from engine.embedding_server import EmbeddingHTTPServer

                EmbeddingHTTPServer(("localhost", 0), HashBackend())
            # 판정 헬퍼도 해석 결과를 따른다.
            self.assertFalse(is_loopback_host("localhost"))

    def test_loopback_hostname_resolving_to_loopback_is_pinned_to_that_literal(self) -> None:
        from unittest.mock import patch

        from engine.embedding_server import resolve_loopback_address

        def fake_resolver(host, port, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0))]

        with patch("engine.embedding_server.socket.getaddrinfo", side_effect=fake_resolver):
            self.assertEqual(resolve_loopback_address("localhost", "bind address"), "127.0.0.1")
            self.assertTrue(is_loopback_host("localhost"))
        # 이름이 아닌 호스트명은 해석조차 하지 않는다(외부 DNS 조회 없음).
        with patch("engine.embedding_server.socket.getaddrinfo") as resolver:
            with self.assertRaises(NonLoopbackEndpointError):
                resolve_loopback_address("embeddings.example.com", "bind address")
        resolver.assert_not_called()

    def test_loopback_classification(self) -> None:
        for host in ("127.0.0.1", "127.1.2.3", "::1", "localhost", "LOCALHOST"):
            self.assertTrue(is_loopback_host(host), host)
        for host in ("0.0.0.0", "10.0.0.1", "::", "example.com", "127.0.0.1.nip.io"):
            self.assertFalse(is_loopback_host(host), host)

    def test_remote_backend_refuses_non_loopback_urls(self) -> None:
        for url in ("http://10.0.0.5:9000/v1", "https://api.example.com/v1",
                    "http://0.0.0.0:9000/v1", "http://[2001:db8::1]:9000/v1"):
            with self.subTest(url=url):
                with self.assertRaises(NonLoopbackEndpointError):
                    RemoteBackend(url)

    def test_remote_backend_accepts_loopback_and_reports_unknown_billing(self) -> None:
        backend = RemoteBackend("http://127.0.0.1:9000/v1/", model_id="m")

        self.assertEqual(backend.base_url, "http://127.0.0.1:9000/v1")
        self.assertFalse(backend.billing_known)
        self.assertFalse(backend.synthetic)
        cost = describe_cost(backend)
        self.assertFalse(cost["free"])
        self.assertIsNone(cost["usd_per_request"])
        self.assertIn("unknown", cost["billing"])

    def test_remote_backend_rejects_bad_urls(self) -> None:
        for url in ("", "127.0.0.1:9000", "ftp://127.0.0.1/v1",
                    "http://user:secret@127.0.0.1:9000/v1"):
            with self.subTest(url=url):
                with self.assertRaises(BackendError):
                    RemoteBackend(url)

    def test_local_backend_fails_loudly_with_actionable_error(self) -> None:
        backend = LocalModelBackend()

        with self.assertRaises(LocalModelUnavailableError) as context:
            backend.embed_batch(["hello"])
        message = str(context.exception)
        self.assertIn("no local embedding weights", message)
        self.assertIn("HARNESS_EMBEDDING_WEIGHTS", message)
        self.assertIn("never downloads", message)
        self.assertFalse(backend.synthetic)
        self.assertFalse(backend.loaded)

        with self.assertRaises(LocalModelUnavailableError) as context:
            LocalModelBackend(weights_path="C:/definitely/missing/weights.bin").embed_batch(["x"])
        self.assertIn("not found", str(context.exception))
        self.assertIn("Nothing was downloaded", str(context.exception))

        with self.assertRaises(LocalModelUnavailableError) as context:
            LocalModelBackend(weights_path=__file__).embed_batch(["x"])
        self.assertIn("no loader", str(context.exception))

    def test_select_backend_rejects_unknown_name_and_missing_remote_url(self) -> None:
        with self.assertRaises(BackendError):
            select_backend("magic")
        with self.assertRaises(BackendError) as context:
            select_backend("remote")
        self.assertIn("HARNESS_EMBEDDING_REMOTE_URL", str(context.exception))
        self.assertIsInstance(select_backend("hash"), HashBackend)


class LocalBackendDisclosureTests(ServerCase):
    def test_local_backend_server_reports_unavailable_instead_of_faking(self) -> None:
        self.server, client = self.start_server(LocalModelBackend())

        status, body = client.json("GET", "/healthz")
        self.assertEqual(status, 503)
        self.assertFalse(body["ok"])
        self.assertEqual(body["backend"]["status"], "unavailable")
        self.assertIn("no local embedding weights", body["backend"]["error"])
        # 적재 전에는 합성 여부를 주장하지 않는다(미상).
        self.assertIsNone(body["backend"]["synthetic"])
        self.assertFalse(body["backend"]["synthetic_known"])

        status, body = client.json("POST", "/v1/embeddings",
                                   {"model": "local/embedding-placeholder-v1", "input": "x"})
        self.assertEqual(status, 503)
        self.assertEqual(body["error"]["code"], "local_model_unavailable")
        self.assertIn("HARNESS_EMBEDDING_WEIGHTS", body["error"]["message"])

    def test_local_backend_with_declaring_loader_reports_non_synthetic_vectors(self) -> None:
        class _StubRuntime:
            dimensions = 4
            synthetic = False
            billing_known = True

            def embed_batch(self, texts):
                return [[float(len(text)), 1.0, 0.0, -1.0] for text in texts]

        backend = LocalModelBackend(weights_path=__file__, loader=lambda path: _StubRuntime())
        info = describe_backend(backend)
        self.assertFalse(info["synthetic"])
        self.assertEqual(info["dimensions"], 4)
        self.assertEqual(info["status"], "ready")
        self.assertTrue(describe_cost(backend)["free"])

    def test_loader_declaring_synthetic_is_reported_as_synthetic(self) -> None:
        class _SyntheticRuntime:
            dimensions = 4
            synthetic = True
            billing_known = True

            def embed_batch(self, texts):
                return [[0.0, 0.0, 0.0, 1.0] for _ in texts]

        backend = LocalModelBackend(weights_path=__file__,
                                    loader=lambda path: _SyntheticRuntime())
        self.assertTrue(describe_backend(backend)["synthetic"])
        _status, headers, _raw = self.start_server(backend)[1].raw(
            "GET", "/healthz")
        self.assertEqual(headers["X-Embedding-Synthetic"], "true")

    def test_loader_returning_a_remote_backend_is_refused(self) -> None:
        remote = RemoteBackend("http://127.0.0.1:9/v1", model_id="stub")
        backend = LocalModelBackend(weights_path=__file__, loader=lambda path: remote)

        # 사용 시점(임베딩)에는 명시적으로 거부한다.
        with self.assertRaises(LocalModelUnavailableError) as context:
            backend.embed_batch(["x"])
        self.assertIn("RemoteBackend", str(context.exception))

        # 서버 공개는 거부 사유를 담은 unavailable 상태이며 무료로 표시하지 않는다.
        self.server, client = self.start_server(backend)
        status, body = client.json("GET", "/healthz")
        self.assertEqual(status, 503)
        self.assertEqual(body["backend"]["status"], "unavailable")
        self.assertIn("RemoteBackend", body["backend"]["error"])
        self.assertFalse(body["cost"]["free"])
        self.assertEqual(client.raw("GET", "/healthz")[1]["X-Embedding-Free"], "false")

    def test_loader_with_undeclared_or_unknown_billing_is_refused(self) -> None:
        class _NoDeclaration:
            dimensions = 4

            def embed_batch(self, texts):
                return [[0.0, 1.0, 0.0, 0.0] for _ in texts]

        class _UnknownBilling:
            dimensions = 4
            synthetic = False
            billing_known = False

            def embed_batch(self, texts):
                return [[0.0, 1.0, 0.0, 0.0] for _ in texts]

        for label, runtime in (("undeclared", _NoDeclaration()),
                               ("unknown-billing", _UnknownBilling())):
            with self.subTest(case=label):
                backend = LocalModelBackend(weights_path=__file__, loader=lambda path, r=runtime: r)
                with self.assertRaises(LocalModelUnavailableError) as context:
                    backend.embed_batch(["x"])
                self.assertIn("billing_known", str(context.exception))
                # 공개도 0원으로 승격되지 않는다.
                self.assertFalse(describe_cost(backend)["free"])
                info = describe_backend(backend)
                self.assertEqual(info["status"], "unavailable")
                self.assertIsNone(info["synthetic"])
                self.assertFalse(info["billing_known"])


class RemoteBackendForwardingTests(ServerCase):
    """루프백 스텁으로 RemoteBackend 전달 경로와 리다이렉트 거부를 검증한다."""

    def _stub(self, handler) -> str:
        class _Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):  # noqa: N802 - 표준 훅 이름
                length = int(self.headers.get("Content-Length", "0"))
                self.rfile.read(length)
                status, body, headers = handler(dict(self.headers))
                payload = json.dumps(body).encode("utf-8")
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(payload)
                self.close_connection = True

            def log_message(self, format, *args):  # noqa: A002
                return

        stub = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        thread = threading.Thread(target=stub.serve_forever, daemon=True)
        thread.start()

        def _stop():
            stub.shutdown()
            stub.server_close()
            thread.join(timeout=10)

        self.addCleanup(_stop)
        return f"http://127.0.0.1:{stub.server_address[1]}/v1"

    def test_forwards_and_parses_openai_response(self) -> None:
        seen: List[Dict[str, Any]] = []

        def handler(headers):
            seen.append(dict(headers))
            return 200, {"object": "list", "data": [
                {"object": "embedding", "index": 0, "embedding": [0.25, 0.5]},
                {"object": "embedding", "index": 1, "embedding": [1.0, 0.0]},
            ], "model": "stub", "usage": {"prompt_tokens": 2, "total_tokens": 2}}, {}

        backend = RemoteBackend(self._stub(handler), model_id="stub")
        vectors = backend.embed_batch(["one", "two"]).vectors

        self.assertEqual(vectors, [[0.25, 0.5], [1.0, 0.0]])
        self.assertEqual(backend.dimensions, 2)
        self.assertEqual(len(seen), 1)

    def test_refuses_redirects(self) -> None:
        def handler(_headers):
            return 302, {}, {"Location": "http://example.com/v1/embeddings"}

        backend = RemoteBackend(self._stub(handler), model_id="stub")

        with self.assertRaises(RemoteBackendError) as context:
            backend.embed_batch(["one"])
        self.assertIn("redirect", str(context.exception))

    def test_rejects_inconsistent_remote_payload(self) -> None:
        def handler(_headers):
            return 200, {"object": "list", "data": [
                {"object": "embedding", "index": 0, "embedding": [0.1, 0.2]},
                {"object": "embedding", "index": 1, "embedding": [0.1]},
            ]}, {}

        backend = RemoteBackend(self._stub(handler), model_id="stub")

        with self.assertRaises(RemoteBackendError) as context:
            backend.embed_batch(["one", "two"])
        self.assertIn("inconsistent dimensions", str(context.exception))

    def test_remote_server_marks_responses_not_free(self) -> None:
        def handler(_headers):
            return 200, {"object": "list", "data": [
                {"object": "embedding", "index": 0, "embedding": [0.5, 0.5]},
            ], "model": "stub", "usage": {"prompt_tokens": 1, "total_tokens": 1}}, {}

        backend = RemoteBackend(self._stub(handler), model_id="stub")
        self.server, client = self.start_server(backend)

        status, headers, raw = client.raw("POST", "/v1/embeddings",
                                          json.dumps({"model": "stub", "input": "x"}).encode(),
                                          {"Content-Type": "application/json"})
        body = json.loads(raw.decode("utf-8"))
        lowered = {key.lower(): value for key, value in headers.items()}

        self.assertEqual(status, 200, body)
        self.assertEqual(lowered["x-embedding-free"], "false")
        self.assertEqual(lowered["x-embedding-cost-usd"], "unknown")
        # 상위가 공개하지 않았으므로 비합성이라고 주장하지 않는다.
        self.assertEqual(lowered["x-embedding-synthetic"], "unknown")
        self.assertEqual(body["data"][0]["embedding"], [0.5, 0.5])

        _status, health = client.json("GET", "/healthz")
        self.assertFalse(health["cost"]["free"])
        self.assertIn("not free", health["cost"]["note"])
        # 엔드포인트 수준 뷰는 요청이 없으므로 미상이다(원격 공개는 요청마다 다르다).
        self.assertIsNone(health["backend"]["synthetic"])
        self.assertFalse(health["backend"]["synthetic_known"])
        self.assertIn("per request", health["backend"]["note"])

    def test_upstream_synthetic_disclosure_is_propagated_not_upgraded(self) -> None:
        """자기 자신의 HashBackend 로 전달해도 비합성으로 승격되지 않아야 한다."""

        def handler(_headers):
            return 200, {"object": "list", "data": [
                {"object": "embedding", "index": 0, "embedding": [0.5, 0.5]},
            ], "model": "stub", "usage": {"prompt_tokens": 1, "total_tokens": 1}}, {
                "X-Embedding-Synthetic": "true",
            }

        backend = RemoteBackend(self._stub(handler), model_id="stub")
        result = backend.embed_batch(["x"])
        # 상위 공개를 그대로, **그 요청의 결과에** 싣는다(백엔드 공유 상태가 아니다).
        self.assertIs(result.synthetic, True)
        self.assertIsNone(backend.synthetic)
        self.assertIsNone(describe_backend(backend)["synthetic"])

        self.server, client = self.start_server(backend)
        _status, headers, _raw = client.raw(
            "POST", "/v1/embeddings",
            json.dumps({"model": "stub", "input": "x"}).encode(),
            {"Content-Type": "application/json"})
        self.assertEqual(headers["X-Embedding-Synthetic"], "true")
        _status, health = client.json("GET", "/healthz")
        # 요청과 무관한 뷰는 미상을 유지한다(승격 없음).
        self.assertIsNone(health["backend"]["synthetic"])
        self.assertFalse(health["backend"]["synthetic_known"])
        self.assertIn("per request", health["backend"]["note"])

    def test_remote_backend_reading_this_servers_own_hash_backend_stays_synthetic(self) -> None:
        upstream, upstream_client = self.start_server(HashBackend(dimensions=8))
        backend = RemoteBackend(f"{upstream.base_url()}/v1", model_id=HASH_MODEL_ID)
        self.server, client = self.start_server(backend)

        status, headers, raw = client.raw(
            "POST", "/v1/embeddings",
            json.dumps({"model": HASH_MODEL_ID, "input": ["alpha beta", "gamma"]}).encode(),
            {"Content-Type": "application/json"})
        body = json.loads(raw.decode("utf-8"))

        self.assertEqual(status, 200, body)
        # 벡터는 상위 HashBackend 와 동일하고, 공개도 합성 그대로 전달된다.
        _status, direct = upstream_client.json(
            "POST", "/v1/embeddings",
            {"model": HASH_MODEL_ID, "input": ["alpha beta", "gamma"]})
        self.assertEqual(body["data"], direct["data"])
        self.assertEqual(headers["X-Embedding-Synthetic"], "true")
        self.assertEqual(headers["X-Embedding-Free"], "false")
        _status, health = client.json("GET", "/healthz")
        self.assertIsNone(health["backend"]["synthetic"])
        self.assertFalse(health["cost"]["free"])


class VectorValidationTests(ServerCase):
    def test_non_finite_vectors_are_rejected_instead_of_emitted(self) -> None:
        class _NaNs:
            synthetic = False
            billing_known = True
            dimensions = 3
            model_id = "stub/nan"

            def embed_batch(self, texts):
                return [[float("nan"), 1.0, 0.0] for _ in texts]

        class _Infinity(_NaNs):
            model_id = "stub/inf"

            def embed_batch(self, texts):
                return [[float("inf"), 1.0, 0.0] for _ in texts]

        for backend in (_NaNs(), _Infinity()):
            with self.subTest(model=backend.model_id):
                self.server, client = self.start_server(backend)
                status, body = client.json(
                    "POST", "/v1/embeddings",
                    {"model": backend.model_id, "input": "x"})
                self.assertEqual(status, 502, body)
                self.assertEqual(body["error"]["code"], "backend_response_invalid")
                self.assertIn("non-finite", body["error"]["message"])
                self.stop_server(self.server)


class JsonParserRejectionTests(ServerCase):
    def setUp(self) -> None:
        self.server, self.client = self.start_server(HashBackend(dimensions=8))

    def test_huge_json_integer_is_a_400_not_a_500(self) -> None:
        # CPython 은 int→str/str→int 변환 자릿수 상한을 넘으면 ValueError 를 던진다.
        huge_integer = b'{"model": ' + b"9" * 5000 + b', "input": "x"}'

        status, body = self.client.json("POST", "/v1/embeddings", raw_body=huge_integer,
                                       headers={"Content-Type": "application/json"})

        self.assertEqual(status, 400, body)
        self.assertEqual(body["error"]["type"], "invalid_request_error")
        self.assertEqual(body["error"]["code"], "invalid_json")
        self.assertIn("JSON", body["error"]["message"])

    def test_deeply_nested_json_is_a_400_not_a_500(self) -> None:
        # CPython 의 json 은 재귀 깊이 한계를 넘으면 RecursionError 를 던진다.
        nested = b"[" * 50000 + b"]" * 50000

        status, body = self.client.json("POST", "/v1/embeddings", raw_body=nested,
                                       headers={"Content-Type": "application/json"})

        self.assertEqual(status, 400, body)
        self.assertEqual(body["error"]["code"], "invalid_json")


class ReadBoundingTests(ServerCase):
    """멈춘 클라이언트가 무기한 스레드를 붙잡지 못하는지 확인한다."""

    def setUp(self) -> None:
        server, self.client = self.start_server(
            HashBackend(dimensions=8), max_body_bytes=1024,
            socket_timeout_seconds=0.5, max_read_seconds=1.0)
        self.port = server.server_address[1]

    def test_silent_connection_releases_its_handler_slot(self) -> None:
        # 요청 라인조차 보내지 않는 연결은 소켓 타임아웃으로 정리되어 슬롯을 반납한다.
        # (이 환경에서는 peer close 가 클라이언트 recv 의 EOF 로 보이지 않으므로, 슬롯
        #  반납과 후속 요청 성공으로 유한한 수명을 확인한다.)
        baseline = {thread.ident for thread in threading.enumerate()}
        with socket.create_connection(("127.0.0.1", self.port), timeout=5.0):
            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline:
                if any(thread.ident not in baseline for thread in threading.enumerate()):
                    break
                time.sleep(0.05)
            self.assertTrue(any(thread.ident not in baseline
                                for thread in threading.enumerate()),
                            "silent connection never reached a handler")
            time.sleep(1.5)  # socket_timeout_seconds(0.5) 를 넘겨 정리가 끝나게 한다

        status, body = self.client.json("GET", "/healthz")
        self.assertEqual(status, 200, body)
        leftover = [thread for thread in threading.enumerate()
                    if thread.ident not in baseline and thread.is_alive()]
        deadline = time.monotonic() + 10.0
        while leftover and time.monotonic() < deadline:
            time.sleep(0.05)
            leftover = [thread for thread in threading.enumerate()
                        if thread.ident not in baseline and thread.is_alive()]
        self.assertEqual(leftover, [], "silent connection kept its handler thread alive")

    def test_oversized_content_length_is_rejected_without_waiting_for_the_body(self) -> None:
        # 본문을 하나도 보내지 않아도 거부 응답이 즉시 온다(드레인 대기 없음).
        status, headers, body = raw_socket_exchange(self.port, (
            b"POST /v1/embeddings HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            b"Content-Type: application/json\r\nContent-Length: 1000000\r\n\r\n"
        ), timeout=5.0)

        self.assertEqual(status, 400)
        self.assertEqual(headers["connection"].lower(), "close")
        error = json.loads(body.decode("utf-8"))["error"]
        self.assertEqual(error["code"], "request_too_large")
        self.assertIn("not read", error["message"])

    def test_stalled_partial_body_times_out_with_a_bounded_response(self) -> None:
        with socket.create_connection(("127.0.0.1", self.port), timeout=5.0) as sock:
            sock.sendall(
                b"POST /v1/embeddings HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                b"Content-Type: application/json\r\nContent-Length: 512\r\n\r\n"
                b'{"model": "local/hash-embedding-v1", "input": "stall'
            )
            started = time.monotonic()
            response = b""
            while b"\r\n\r\n" not in response:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk
            elapsed = time.monotonic() - started
            head, _, body = response.partition(b"\r\n\r\n")
            length = 0
            for line in head.split(b"\r\n")[1:]:
                key, _, value = line.partition(b":")
                if key.strip().lower() == b"content-length":
                    length = int(value.strip())
            while len(body) < length:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                body += chunk

        self.assertLess(elapsed, 5.0, "stalled client was not bounded")
        self.assertIn(b" 408 ", head.split(b"\r\n")[0] + b" ")
        error = json.loads(body.decode("utf-8"))["error"]
        self.assertEqual(error["code"], "request_timeout")
        self.assertIn("timed out", error["message"])

    def test_stalled_client_leaves_no_handler_thread_behind(self) -> None:
        baseline = {thread.ident for thread in threading.enumerate()}
        with socket.create_connection(("127.0.0.1", self.port), timeout=5.0) as sock:
            sock.sendall(
                b"POST /v1/embeddings HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                b"Content-Type: application/json\r\nContent-Length: 64\r\n\r\n"
                b"{")
            sock.recv(4096)

        deadline = time.monotonic() + 10.0
        leftover = []
        while time.monotonic() < deadline:
            leftover = [thread for thread in threading.enumerate()
                        if thread.ident not in baseline and thread.is_alive()]
            if not leftover:
                break
            time.sleep(0.05)
        self.assertEqual(leftover, [], "handler threads survived the stalled request")


class AdmissionControlTests(ServerCase):
    def test_concurrent_requests_beyond_the_cap_get_an_immediate_503(self) -> None:
        server, client = self.start_server(
            HashBackend(dimensions=8), max_concurrent_requests=1,
            socket_timeout_seconds=0.5, max_read_seconds=2.0)
        port = server.server_address[1]

        # 첫 연결을 일부러 멈춰 두어 핸들러 슬롯 하나를 점유한다.
        with socket.create_connection(("127.0.0.1", port), timeout=5.0) as stalled:
            stalled.sendall(
                b"POST /v1/embeddings HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                b"Content-Type: application/json\r\nContent-Length: 512\r\n\r\n{")

            deadline = time.monotonic() + 5.0
            status = None
            while time.monotonic() < deadline:
                status, headers, body = raw_socket_exchange(
                    port, b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", timeout=5.0)
                if status == 503:
                    break
                time.sleep(0.05)

        self.assertEqual(status, 503)
        self.assertEqual(headers["retry-after"], "1")
        error = json.loads(body.decode("utf-8"))["error"]
        self.assertEqual(error["code"], "too_many_concurrent_requests")
        self.assertIn("limit is 1", error["message"])

    def test_capacity_is_released_after_a_request_completes(self) -> None:
        _server, client = self.start_server(HashBackend(dimensions=8),
                                            max_concurrent_requests=1)
        for _ in range(3):
            status, body = client.json("GET", "/healthz")
            self.assertEqual(status, 200, body)


class AggregateReadBudgetTests(ServerCase):
    """느린 트리클 클라이언트가 **집계** 읽기 예산을 우회하지 못하는지 확인한다.

    회귀 대상: 소켓 타임아웃은 ``rfile.read(n)`` 호출마다 한 번만 걸렸고, 버퍼 파일 객체는
    내부에서 ``recv_into`` 를 반복하므로 비활동 창 직전 간격으로 한 바이트씩 보내는
    클라이언트가 한 호출 안에서 예산을 무한정 늘릴 수 있었다.
    """

    def setUp(self) -> None:
        server, self.client = self.start_server(
            HashBackend(dimensions=8), max_body_bytes=65536,
            socket_timeout_seconds=0.4, max_read_seconds=1.2)
        self.port = server.server_address[1]

    @staticmethod
    def _trickle(sock: socket.socket, payload: bytes, interval: float,
                 stop: threading.Event) -> None:
        for index in range(len(payload)):
            if stop.is_set():
                return
            try:
                sock.sendall(payload[index:index + 1])
            except OSError:  # 서버가 예산을 넘겨 연결을 끊었다
                return
            time.sleep(interval)

    def test_body_trickled_under_the_inactivity_window_hits_the_aggregate_budget(self) -> None:
        declared = 4096
        stop = threading.Event()
        with socket.create_connection(("127.0.0.1", self.port), timeout=10.0) as sock:
            sock.sendall(
                b"POST /v1/embeddings HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                b"Content-Type: application/json\r\n"
                + f"Content-Length: {declared}\r\n\r\n".encode("ascii")
            )
            trickler = threading.Thread(
                target=self._trickle,
                args=(sock, b" " * declared, 0.25, stop),  # 0.25s < 비활동 창 0.4s
                daemon=True,
            )
            started = time.monotonic()
            trickler.start()
            try:
                status, headers, body = read_http_response(sock)
            finally:
                elapsed = time.monotonic() - started
                stop.set()
                trickler.join(timeout=5.0)

        # 예산(1.2s)에서 끊긴다. 트리클을 그대로 허용하면 4096 * 0.25s ≈ 17분이 걸린다.
        self.assertEqual(status, 408, body)
        self.assertLess(elapsed, 4.0, f"trickled body was not bounded ({elapsed:.2f}s)")
        self.assertGreaterEqual(elapsed, 0.9, "budget ended sooner than max_read_seconds")
        self.assertEqual(headers["connection"].lower(), "close")
        error = json.loads(body.decode("utf-8"))["error"]
        self.assertEqual(error["code"], "request_timeout")

    def test_header_block_trickled_under_the_inactivity_window_hits_the_aggregate_budget(self) -> None:
        header_tail = b"X-Slow: " + b"a" * 4096 + b"\r\n\r\n"
        stop = threading.Event()
        with socket.create_connection(("127.0.0.1", self.port), timeout=10.0) as sock:
            sock.sendall(b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n")
            trickler = threading.Thread(
                target=self._trickle, args=(sock, header_tail, 0.25, stop), daemon=True)
            started = time.monotonic()
            trickler.start()
            try:
                status, headers, body = read_http_response(sock)
            finally:
                elapsed = time.monotonic() - started
                stop.set()
                trickler.join(timeout=5.0)

        # 요청 라인/헤더도 자기 집계 예산을 갖는다(비활동 창만으로는 무기한 유지됐다).
        self.assertEqual(status, 408, body)
        self.assertLess(elapsed, 4.0, f"trickled headers were not bounded ({elapsed:.2f}s)")
        self.assertEqual(headers["connection"].lower(), "close")
        self.assertEqual(json.loads(body.decode("utf-8"))["error"]["code"],
                         "request_timeout")


class PerRequestDisclosureTests(ServerCase):
    """원격 공개값이 **요청별**로만 흐르는지 확인한다(동시 요청 사이 누설 금지)."""

    def _stub(self, headers_sent: Optional[threading.Event] = None) -> str:
        """텍스트로 동작을 고르는 루프백 스텁. ``omit-slow`` 는 머리말을 먼저 보낸다."""
        behaviours: Dict[str, Tuple[Optional[str], float]] = {
            "omit-slow": (None, 0.6),
            "omit": (None, 0.0),
            "non-synthetic": ("false", 0.0),
            "synthetic": ("true", 0.0),
            "bogus": ("maybe", 0.0),
        }

        class _Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):  # noqa: N802 - 표준 훅 이름
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length))
                text = payload["input"]
                if isinstance(text, list):
                    text = text[0]
                disclosure, delay = behaviours.get(text, (None, 0.0))
                entry = {"object": "list", "data": [
                    {"object": "embedding", "index": 0, "embedding": [0.5, 0.5]}],
                    "model": "stub", "usage": {"prompt_tokens": 1, "total_tokens": 1}}
                body = json.dumps(entry).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                if disclosure is not None:
                    self.send_header(RemoteBackend.DISCLOSURE_HEADER, disclosure)
                self.send_header("Connection", "close")
                self.end_headers()
                if delay:
                    # 공개 판독(머리말)과 응답 쓰기 사이에 다른 요청이 끼어들 수 있게 한다.
                    self.wfile.flush()
                    if headers_sent is not None:
                        headers_sent.set()
                    time.sleep(delay)
                self.wfile.write(body)
                self.close_connection = True

            def log_message(self, format, *args):  # noqa: A002
                return

        stub = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        thread = threading.Thread(target=stub.serve_forever, daemon=True)
        thread.start()

        def _stop():
            if not getattr(stub, "_test_stopped", False):
                stub._test_stopped = True
                stub.shutdown()
            stub.server_close()
            if thread.is_alive():
                thread.join(timeout=10)

        self.addCleanup(_stop)
        return f"http://127.0.0.1:{stub.server_address[1]}/v1"

    def test_omitting_upstream_is_unknown_while_a_concurrent_false_request_is_false(self) -> None:
        headers_sent = threading.Event()
        backend = RemoteBackend(self._stub(headers_sent), model_id="stub")
        self.server, client = self.start_server(backend)

        captured: Dict[str, Tuple[int, Dict[str, str], bytes]] = {}

        def slow_call() -> None:
            captured["omit"] = client.raw(
                "POST", "/v1/embeddings",
                json.dumps({"model": "stub", "input": "omit-slow"}).encode("utf-8"),
                {"Content-Type": "application/json"})

        slow = threading.Thread(target=slow_call, name="omit-request", daemon=True)
        slow.start()
        try:
            # A(공개 헤더 없음)가 머리말을 읽은 뒤 본문을 기다리는 동안 B(false)가 끝난다.
            self.assertTrue(headers_sent.wait(5.0), "slow upstream never sent its headers")
            status, headers, raw = client.raw(
                "POST", "/v1/embeddings",
                json.dumps({"model": "stub", "input": "non-synthetic"}).encode("utf-8"),
                {"Content-Type": "application/json"})
            lowered = {key.lower(): value for key, value in headers.items()}
            self.assertEqual(status, 200, raw)
            self.assertEqual(lowered["x-embedding-synthetic"], "false")
        finally:
            slow.join(timeout=10.0)

        slow_status, slow_headers, slow_raw = captured["omit"]
        slow_lowered = {key.lower(): value for key, value in slow_headers.items()}
        self.assertEqual(slow_status, 200, slow_raw)
        # A 의 상위는 공개하지 않았다 → 요청 B 의 false 가 새어 들어오면 이 단언이 깨진다.
        self.assertEqual(slow_lowered["x-embedding-synthetic"], "unknown")
        self.assertEqual(json.loads(slow_raw.decode("utf-8"))["data"][0]["index"], 0)

    def test_single_request_disclosure_mapping_is_unchanged(self) -> None:
        backend = RemoteBackend(self._stub(), model_id="stub")
        self.server, client = self.start_server(backend)

        expected = {
            "omit": "unknown",
            "bogus": "unknown",
            "non-synthetic": "false",
            "synthetic": "true",
        }
        for text, header in expected.items():
            with self.subTest(text=text):
                status, headers, raw = client.raw(
                    "POST", "/v1/embeddings",
                    json.dumps({"model": "stub", "input": text}).encode("utf-8"),
                    {"Content-Type": "application/json"})
                lowered = {key.lower(): value for key, value in headers.items()}
                self.assertEqual(status, 200, raw)
                self.assertEqual(lowered["x-embedding-synthetic"], header)
                # 백엔드는 공개 상태를 요청 사이에 저장하지 않는다.
                self.assertIsNone(backend.synthetic)


class AddressFamilyBindTests(unittest.TestCase):
    """해석된 루프백 주소의 패밀리에 서버 소켓 패밀리를 맞춘다(``bind`` OSError 회귀 방지)."""

    def _serve_and_check(self, server, host_literal: str) -> None:
        from engine.embedding_server import HashBackend as _HashBackend  # noqa: F401

        thread = threading.Thread(target=server.serve_forever, name="family-test", daemon=True)
        thread.start()
        try:
            with socket.create_connection((host_literal, server.server_address[1]),
                                          timeout=5.0) as sock:
                sock.sendall(b"GET /healthz HTTP/1.1\r\nHost: loopback\r\n\r\n")
                status, _headers, body = read_http_response(sock)
            self.assertEqual(status, 200, body)
            payload = json.loads(body.decode("utf-8"))
            self.assertTrue(payload["bind"]["loopback"])
            self.assertEqual(payload["bind"]["host"], host_literal)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=10.0)

    def test_ipv6_loopback_literal_binds_or_reports_the_family_error(self) -> None:
        from engine.embedding_server import create_server

        try:
            server = create_server(HashBackend(dimensions=8), host="::1", port=0)
        except BindAddressFamilyError as exc:
            # AF_INET 소켓에 IPv6 리터럴을 넘기던 결함은 막연한 OSError 였다.
            self.assertIn("AF_INET6", str(exc))
            self.assertIn("::1", str(exc))
            return
        try:
            self.assertEqual(server.address_family, socket.AF_INET6)
            self.assertEqual(server.server_address[0], "::1")
            self.assertTrue(server.base_url().startswith("http://[::1]:"))
            self._serve_and_check(server, "::1")
        finally:
            server.server_close()

    def test_ipv6_first_localhost_binds_or_reports_the_family_error(self) -> None:
        from unittest.mock import patch

        from engine.embedding_server import create_server

        real_getaddrinfo = socket.getaddrinfo

        def ipv6_first(host, port, *args, **kwargs):
            if host == "localhost":
                return [
                    (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::1", 0, 0, 0)),
                    (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0)),
                ]
            return real_getaddrinfo(host, port, *args, **kwargs)

        with patch("engine.embedding_server.socket.getaddrinfo", side_effect=ipv6_first):
            try:
                server = create_server(HashBackend(dimensions=8), host="localhost", port=0)
            except BindAddressFamilyError as exc:
                self.assertIn("AF_INET6", str(exc))
                return
        try:
            # IPv6 우선 해석 결과가 그대로 AF_INET 소켓에 넘어가면 bind 에서 깨진다.
            self.assertEqual(server.address_family, socket.AF_INET6)
            self.assertEqual(server.server_address[0], "::1")
            self._serve_and_check(server, "::1")
        finally:
            server.server_close()

    def test_unsupported_family_fails_with_a_named_error_and_keeps_the_loopback_guard(self) -> None:
        from unittest.mock import patch

        from engine.embedding_server import create_server

        real_socket = socket.socket

        def no_ipv6(family=socket.AF_INET, *args, **kwargs):
            if family == socket.AF_INET6:
                raise OSError(errno.EAFNOSUPPORT, "Address family not supported")
            return real_socket(family, *args, **kwargs)

        with patch("engine.embedding_server.socket.socket", side_effect=no_ipv6):
            with self.assertRaises(BindAddressFamilyError) as context:
                create_server(HashBackend(dimensions=8), host="::1", port=0)
            # 루프백 보장은 그대로다(패밀리 문제와 무관한 비루프백은 여전히 거부).
            with self.assertRaises(NonLoopbackBindError):
                create_server(HashBackend(dimensions=8), host="0.0.0.0", port=0)
        message = str(context.exception)
        self.assertIn("AF_INET6", message)
        self.assertIn("loopback-only", message)


class TeardownTests(ServerCase):
    """``stop_server`` 가 멱등이고 serve 스레드를 join 하는지 확인한다."""

    def test_stop_server_is_idempotent_and_joins_the_serve_thread(self) -> None:
        server, client = self.start_server(HashBackend(dimensions=8))
        thread = self._serve_threads()[id(server)]
        port = server.server_address[1]
        self.assertTrue(thread.is_alive())
        self.assertEqual(client.json("GET", "/healthz")[0], 200)

        self.stop_server(server)
        self.assertFalse(thread.is_alive(), "serve_forever thread was not joined")
        # 두 번째 정지(예: addCleanup)도 조용히 통과해야 한다.
        self.stop_server(server)
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=1.0).close()

    def test_mid_test_stop_leaves_neither_thread_nor_listener(self) -> None:
        baseline = {thread.ident for thread in threading.enumerate()}
        server, _client = self.start_server(HashBackend(dimensions=8))
        port = server.server_address[1]
        self.stop_server(server)

        deadline = time.monotonic() + 10.0
        leftover = [thread for thread in threading.enumerate()
                    if thread.ident not in baseline and thread.is_alive()]
        while leftover and time.monotonic() < deadline:
            time.sleep(0.05)
            leftover = [thread for thread in threading.enumerate()
                        if thread.ident not in baseline and thread.is_alive()]
        self.assertEqual(leftover, [], "teardown left a live thread behind")
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=1.0).close()


class HealthCheckDnsTests(ServerCase):
    """/healthz 는 매 요청 DNS 조회에 의존하지 않는다."""

    def test_healthz_classifies_the_bind_literal_without_resolving(self) -> None:
        from unittest.mock import patch

        self.server, client = self.start_server(HashBackend(dimensions=8))
        real_getaddrinfo = socket.getaddrinfo
        resolved_names: List[str] = []

        def no_name_lookup(host, port, *args, **kwargs):
            if host not in ("127.0.0.1", "::1"):
                resolved_names.append(str(host))
                raise AssertionError(f"/healthz must not resolve names ({host!r})")
            return real_getaddrinfo(host, port, *args, **kwargs)

        def boom(*_args, **_kwargs):
            raise AssertionError("/healthz must not resolve the bind address")

        with patch("engine.embedding_server.resolve_loopback_address", side_effect=boom), \
                patch("engine.embedding_server.socket.getaddrinfo",
                      side_effect=no_name_lookup):
            status, body = client.json("GET", "/healthz")

        self.assertEqual(status, 200, body)
        self.assertEqual(resolved_names, [])
        self.assertTrue(body["bind"]["loopback"])
        self.assertEqual(body["bind"]["host"], "127.0.0.1")

    def test_loopback_literal_classification_is_resolution_free(self) -> None:
        from unittest.mock import patch

        with patch("engine.embedding_server.socket.getaddrinfo") as resolver:
            for host in ("127.0.0.1", "127.1.2.3", "::1", "[::1]", " 127.0.0.1 "):
                self.assertTrue(is_loopback_literal(host), host)
            for host in ("0.0.0.0", "::", "localhost", "example.com", ""):
                self.assertFalse(is_loopback_literal(host), host)
        resolver.assert_not_called()


class CliSurfaceTests(unittest.TestCase):
    def test_default_backend_is_the_synthetic_hash_backend(self) -> None:
        from engine.embedding_server import build_parser

        args = build_parser().parse_args([])
        self.assertEqual(args.backend, "hash")
        self.assertEqual(args.host, "127.0.0.1")
        self.assertFalse(args.allow_non_loopback)

    def test_timeout_and_admission_limits_are_configurable(self) -> None:
        from engine.embedding_server import (
            DEFAULT_MAX_CONCURRENT_REQUESTS,
            DEFAULT_MAX_READ_SECONDS,
            DEFAULT_SOCKET_TIMEOUT_SECONDS,
            build_parser,
        )

        args = build_parser().parse_args([])
        self.assertEqual(args.max_concurrent_requests, DEFAULT_MAX_CONCURRENT_REQUESTS)
        self.assertEqual(args.socket_timeout_seconds, DEFAULT_SOCKET_TIMEOUT_SECONDS)
        self.assertEqual(args.max_read_seconds, DEFAULT_MAX_READ_SECONDS)


if __name__ == "__main__":
    unittest.main()
