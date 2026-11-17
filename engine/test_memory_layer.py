"""memory_layer 테스트: 멱등 수집, 해시 갱신, 렉시컬 순위, RRF, 격리, purge, 예산."""
from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import tempfile
import unittest

from engine.memory_layer import (
    CHUNK_OVERLAP_TOKENS,
    CHUNK_TOKENS,
    RRF_K,
    BudgetExceededError,
    DocumentTooLargeError,
    MemoryLayer,
    chunk_text,
)

CORPUS = {
    "ops/retry.md": "The runner retries a failed build twice before it escalates to a human operator.",
    "ops/cache.md": "Cache eviction drops the least recently used planner artifact whenever memory is tight.",
    "docs/planner.md": "The planner builds a deterministic DAG and never retries on its own.",
}


def hashed_embedder(dimension: int = 32):
    """결정론적 로컬 임베더: 토큰을 해시해 고정 차원 벡터에 누적한다(네트워크 없음)."""

    def embed(text: str) -> list[float]:
        vector = [0.0] * dimension
        for token in text.lower().split():
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            vector[digest[0] % dimension] += 1.0
        return vector

    return embed


class MemoryLayerCase(unittest.TestCase):
    def setUp(self) -> None:
        self.layer = MemoryLayer(":memory:", namespace="user-a")
        self.addCleanup(self.layer.close)

    def search(self, query, layer=None, top_k=5, **kwargs):
        target = self.layer if layer is None else layer
        return target.search(query, top_k=top_k, **kwargs)


class IngestionTests(MemoryLayerCase):
    def test_reingest_identical_text_is_idempotent(self) -> None:
        first = self.layer.add_document(CORPUS["ops/retry.md"], "ops/retry.md", {"tag": "ops"})
        second = self.layer.add_document(CORPUS["ops/retry.md"], "ops/retry.md", {"tag": "ops"})
        third = self.layer.add_document(CORPUS["ops/retry.md"], "ops/retry.md", {"tag": "changed"})

        self.assertEqual(first["status"], "added")
        self.assertEqual(second["status"], "skipped-duplicate")
        self.assertEqual(third["status"], "skipped-duplicate")
        self.assertEqual(second["chunks"], first["chunks"])
        self.assertEqual(self.layer.stats()["documents"], 1)
        self.assertEqual(self.layer.stats()["chunks"], first["chunks"])

    def test_changed_text_updates_in_place(self) -> None:
        original = "The runner retries a failed build twice."
        replacement = "The scheduler defers a failed build until the nightly window."
        added = self.layer.add_document(original, "ops/retry.md")
        updated = self.layer.add_document(replacement, "ops/retry.md")

        self.assertEqual(updated["status"], "updated")
        self.assertEqual(updated["doc_id"], added["doc_id"])
        self.assertNotEqual(updated["content_hash"], added["content_hash"])
        self.assertEqual(self.layer.stats()["documents"], 1)
        self.assertEqual(self.search("scheduler")["results"][0]["source"], "ops/retry.md")
        self.assertEqual(self.search("retries twice")["results"], [])

    def test_chunking_window_and_overlap_are_applied(self) -> None:
        text = " ".join(f"word{index}" for index in range(300))
        chunks = chunk_text(text)
        self.assertGreater(len(chunks), 1)
        self.assertEqual(chunks[0]["char_start"], 0)
        second_start = chunks[1]["char_start"]
        first_words = chunks[0]["content"].split()
        self.assertEqual(len(first_words), CHUNK_TOKENS)
        self.assertEqual(len(chunks[1]["content"].split()), CHUNK_TOKENS)
        overlapped = text[second_start : chunks[0]["char_end"]].split()
        self.assertEqual(len(overlapped), CHUNK_OVERLAP_TOKENS)

        result = self.layer.add_document(text, "long/ladder.txt")
        self.assertEqual(result["chunks"], len(chunks))


class RetrievalTests(MemoryLayerCase):
    def setUp(self) -> None:
        super().setUp()
        for source, text in CORPUS.items():
            self.layer.add_document(text, source)

    def test_fts_backend_ranks_most_specific_document_first(self) -> None:
        payload = self.search("cache eviction planner artifact", top_k=3)

        self.assertEqual(payload["backend"], "fts5")
        self.assertTrue(payload["capabilities"]["fts5_available"])
        self.assertEqual(payload["mode"], "lexical")
        self.assertEqual(payload["results"][0]["source"], "ops/cache.md")
        self.assertLess(payload["results"][0]["bm25"], 0.0)
        scores = [item["score"] for item in payload["results"]]
        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_rrf_scores_match_ranks_without_embedder(self) -> None:
        payload = self.search("runner retries failed build", top_k=3)

        self.assertFalse(payload["embedding_used"])
        self.assertEqual(payload["mode"], "lexical")
        self.assertEqual(payload["rrf_k"], RRF_K)
        top = payload["results"][0]
        self.assertEqual(top["source"], "ops/retry.md")
        self.assertEqual(sorted(top["ranks"]), ["lexical", "overlap"])
        expected = sum(1.0 / (RRF_K + rank) for rank in top["ranks"].values())
        self.assertAlmostEqual(top["score"], expected, places=12)

    def test_embedder_adds_third_rrf_signal(self) -> None:
        embedded = MemoryLayer(":memory:", namespace="user-a", embedder=hashed_embedder())
        self.addCleanup(embedded.close)
        for source, text in CORPUS.items():
            embedded.add_document(text, source)

        with_embedding = embedded.search("runner retries failed build", top_k=3)
        self.assertTrue(with_embedding["capabilities"]["embedding_enabled"])
        self.assertTrue(with_embedding["embedding_used"])
        self.assertEqual(with_embedding["mode"], "lexical+embedding")
        ranked_by_embedding = [
            item for item in with_embedding["results"] if "embedding" in item["ranks"]
        ]
        self.assertTrue(ranked_by_embedding)
        self.assertEqual(ranked_by_embedding[0]["source"], "ops/retry.md")
        expected = sum(
            1.0 / (RRF_K + rank) for rank in ranked_by_embedding[0]["ranks"].values()
        )
        self.assertAlmostEqual(ranked_by_embedding[0]["score"], expected, places=12)

        lexical = MemoryLayer(":memory:", namespace="user-a")
        self.addCleanup(lexical.close)
        for source, text in CORPUS.items():
            lexical.add_document(text, source)
        self.assertEqual(lexical.search("runner retries failed build")["mode"], "lexical")

    def test_embedder_attached_later_reports_lexical_until_vectors_exist(self) -> None:
        # 벡터 없이 수집한 문서에 임베더를 나중에 붙이면 코사인 랭커가 비어 있고,
        # 결과는 lexical로 정직하게 보고되어야 한다.
        tmp = tempfile.mkdtemp()
        db_path = os.path.join(tmp, "late.sqlite3")
        opened: list[MemoryLayer] = []

        def _cleanup() -> None:
            for layer in opened:
                layer.close()
            shutil.rmtree(tmp, ignore_errors=True)

        self.addCleanup(_cleanup)
        plain = MemoryLayer(db_path, namespace="user-a")
        opened.append(plain)
        plain.add_document(CORPUS["ops/cache.md"], "ops/cache.md")
        plain.close()
        opened.remove(plain)

        attached = MemoryLayer(db_path, namespace="user-a", embedder=hashed_embedder())
        opened.append(attached)
        payload = attached.search("cache eviction planner artifact", top_k=3)
        self.assertTrue(payload["capabilities"]["embedding_enabled"])
        self.assertFalse(payload["embedding_used"])
        self.assertEqual(payload["mode"], "lexical")
        self.assertEqual(payload["results"][0]["source"], "ops/cache.md")

    def test_korean_query_matches_agglutinated_text(self) -> None:
        # unicode61은 한글을 공백 단위로만 자르므로 "롤백"으로 "롤백은"을 찾지 못한다.
        layer = MemoryLayer(":memory:", namespace="ko")
        self.addCleanup(layer.close)
        layer.add_document(
            "배포 파이프라인은 실패한 빌드에서 롤아웃을 멈춘다. 롤백은 이전 휠로 되돌린다.",
            "notes/ko.md",
        )
        payload = layer.search("롤백 휠", top_k=3)
        self.assertEqual([item["source"] for item in payload["results"]], ["notes/ko.md"])
        self.assertIn("lexical", payload["results"][0]["ranks"])

    def test_special_characters_do_not_raise_fts5_syntax_errors(self) -> None:
        hostile = 'retries AND "build"* OR cache:planner -runner ^tight (def x(): a->b) 100% "'
        payload = self.search(hostile, top_k=3)
        self.assertEqual(payload["backend"], "fts5")
        self.assertTrue(payload["results"])
        sources = {item["source"] for item in payload["results"]}
        self.assertTrue(sources & {"ops/retry.md", "ops/cache.md", "docs/planner.md"})

        punctuation_only = self.search('*** ":" - - ^^ !!!')
        self.assertEqual(punctuation_only["results"], [])

    def test_query_with_no_matching_terms_returns_empty(self) -> None:
        payload = self.search("kubernetes helm chart", top_k=3)
        self.assertEqual(payload["results"], [])
        self.assertEqual(payload["mode"], "lexical")


class FallbackTests(MemoryLayerCase):
    def test_forced_like_fallback_reports_capability(self) -> None:
        layer = MemoryLayer(":memory:", namespace="user-a", force_like_fallback=True)
        self.addCleanup(layer.close)
        for source, text in CORPUS.items():
            layer.add_document(text, source)

        capabilities = layer.capabilities()
        # 빌드의 실제 FTS5 지원과 이 인스턴스의 선택(LIKE 강제)은 별개다.
        self.assertTrue(capabilities["fts5_available"])
        self.assertTrue(capabilities["forced_like_fallback"])
        self.assertEqual(capabilities["backend"], "like")
        self.assertIsNone(capabilities["tokenizer"])

        payload = layer.search("cache eviction planner artifact", top_k=3)
        self.assertEqual(payload["backend"], "like")
        self.assertTrue(payload["capabilities"]["fts5_available"])
        self.assertTrue(payload["capabilities"]["forced_like_fallback"])
        self.assertEqual(payload["results"][0]["source"], "ops/cache.md")
        self.assertIsNone(payload["results"][0]["bm25"])
        self.assertGreater(payload["results"][0]["term_frequency"], 0)
        # 읽기만 강등된다: 색인은 계속 유지되므로 새 문서도 이후 FTS 검색에서 보인다.
        self.assertEqual(layer.add_document("Cache eviction again.", "ops/dup.md")["status"], "added")
        self.assertEqual(layer.search("eviction")["results"][0]["source"], "ops/cache.md")
        self.assertIsNotNone(layer.fts_table_name("user-a"))
        self.assertEqual(layer.purge("user-a")["documents_deleted"], 4)
        self.assertEqual(layer.stats()["documents"], 0)

    def test_like_fallback_escapes_wildcards(self) -> None:
        layer = MemoryLayer(":memory:", force_like_fallback=True)
        self.addCleanup(layer.close)
        layer.add_document("A plain sentence without wildcard characters.", "plain.md")
        layer.add_document("A different note about caching.", "other.md")

        # 이스케이프가 깨지면 '%_%'가 모든 행과 매칭되어 두 문서가 모두 나온다.
        underscore_only = layer.search("_", top_k=5)
        self.assertEqual(underscore_only["backend"], "like")
        self.assertEqual(underscore_only["results"], [])

        payload = layer.search('sentence %_ "quote"', top_k=5)
        self.assertEqual(payload["backend"], "like")
        self.assertEqual([item["source"] for item in payload["results"]], ["plain.md"])


    def test_reopening_like_database_in_fts_mode_backfills_index(self) -> None:
        tmp = tempfile.mkdtemp()
        db_path = os.path.join(tmp, "reopen.sqlite3")
        opened: list[MemoryLayer] = []

        def _cleanup() -> None:
            for layer in opened:
                layer.close()
            shutil.rmtree(tmp, ignore_errors=True)

        self.addCleanup(_cleanup)
        fallback = MemoryLayer(db_path, force_like_fallback=True)
        opened.append(fallback)
        fallback.add_document("Cache eviction dropped planner artifacts.", "cache.md")
        fallback.add_document("The runner retries a failed build twice.", "retry.md")
        self.assertEqual(fallback.search("cache eviction")["backend"], "like")

        # 백필 경로를 실제로 타도록 색인이 없는 상태를 SQL 수준에서 만든다.
        # (``add_document``는 강제 폴백에서도 색인을 유지하므로 그냥 닫으면
        #  재개방 시 '테이블이 이미 있음' 빠른 경로로 빠져 백필을 검증할 수 없다.)
        stale_index = fallback.fts_table_name("default")
        self.assertIsNotNone(stale_index)
        fallback.conn.execute(f'DROP TABLE "{stale_index}"')
        fallback.conn.execute("DELETE FROM fts_indexes")
        self.assertEqual(
            fallback.conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' "
                                  "AND name = ?", (stale_index,)).fetchone()[0], 0)
        self.assertIsNone(fallback.fts_table_name("default"))
        fallback.close()
        opened.remove(fallback)

        upgraded = MemoryLayer(db_path)
        opened.append(upgraded)
        rebuilt_index = upgraded.fts_table_name("default")
        self.assertEqual(rebuilt_index, stale_index)
        # 색인은 ``chunks``에서 다시 채워졌다: 행 수가 청크 수와 같다.
        chunk_total = upgraded.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        indexed = upgraded.conn.execute(f'SELECT COUNT(*) FROM "{rebuilt_index}"').fetchone()[0]
        self.assertEqual((chunk_total, indexed), (2, 2))
        self.assertEqual(upgraded.search("cache eviction")["backend"], "fts5")
        self.assertEqual(upgraded.search("cache eviction")["results"][0]["source"], "cache.md")
        self.assertEqual(upgraded.search("runner retries")["results"][0]["source"], "retry.md")


class IndexRebuildTests(MemoryLayerCase):
    """색인이 세션 도중 사라져도(직접 DROP, 다른 연결의 purge) 작업은 복구되어야 한다."""

    def test_dropped_index_is_rebuilt_within_same_connection(self) -> None:
        tmp = tempfile.mkdtemp()
        db_path = os.path.join(tmp, "drop.sqlite3")
        layer = MemoryLayer(db_path, namespace="alice")

        def _cleanup() -> None:
            layer.close()
            shutil.rmtree(tmp, ignore_errors=True)

        self.addCleanup(_cleanup)
        layer.add_document("Cache eviction dropped planner artifacts.", "cache.md")
        index = layer.fts_table_name("alice")
        self.assertIsNotNone(index)
        # 등록 행은 남긴 채 테이블만 사라진 상태를 만든다(캐시가 낡은 이름을 들고 있다).
        layer.conn.execute(f'DROP TABLE "{index}"')
        self.assertEqual(layer._table_exists(index), False)

        added = layer.add_document("The runner retries a failed build twice.", "retry.md")
        self.assertEqual(added["status"], "added")
        self.assertEqual(layer.fts_table_name("alice"), index)
        self.assertTrue(layer._table_exists(index))
        indexed = layer.conn.execute(f'SELECT COUNT(*) FROM "{index}"').fetchone()[0]
        chunk_total = layer.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        self.assertEqual((indexed, chunk_total), (2, 2))
        payload = layer.search("cache eviction", top_k=3)
        self.assertEqual(payload["backend"], "fts5")
        self.assertEqual([item["source"] for item in payload["results"]], ["cache.md"])

        # 갱신 경로(_drop_chunks)도 색인이 사라진 뒤 다시 만들고 계속 진행한다.
        layer.conn.execute(f'DROP TABLE "{index}"')
        updated = layer.add_document("Cache eviction now keeps the planner artifact.", "cache.md")
        self.assertEqual(updated["status"], "updated")
        indexed = layer.conn.execute(f'SELECT COUNT(*) FROM "{index}"').fetchone()[0]
        chunk_total = layer.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        self.assertEqual((indexed, chunk_total), (2, 2))
        self.assertEqual(layer.search("artifact", top_k=3)["results"][0]["source"], "cache.md")

        # 검색만 먼저 해도(쓰기 없이) 색인이 다시 세워진다.
        layer.conn.execute(f'DROP TABLE "{index}"')
        recovered = layer.search("cache eviction", top_k=3)
        self.assertEqual(recovered["backend"], "fts5")
        self.assertEqual([item["source"] for item in recovered["results"]], ["cache.md"])

    def test_purge_from_another_connection_does_not_break_open_instance(self) -> None:
        tmp = tempfile.mkdtemp()
        db_path = os.path.join(tmp, "crosspurge.sqlite3")
        alice = MemoryLayer(db_path, namespace="alice")
        bob = MemoryLayer(db_path, namespace="bob")

        def _cleanup() -> None:
            alice.close()
            bob.close()
            shutil.rmtree(tmp, ignore_errors=True)

        self.addCleanup(_cleanup)
        alice.add_document("Alice keeps her retry budget in the ledger.", "notes/ledger.md")
        bob.add_document("Bob keeps his cache eviction note.", "notes/bob-cache.md")
        stale_index = alice.fts_table_name("alice")
        self.assertIsNotNone(stale_index)

        purged = bob.purge("alice")
        self.assertEqual(purged["documents_deleted"], 1)
        self.assertFalse(alice._table_exists(stale_index))

        # alice는 열린 채로 남아 있고, 캐시에는 사라진 색인 이름이 들어 있다.
        added = alice.add_document("Alice rebuilds the ledger after the purge.", "notes/new.md")
        self.assertEqual(added["status"], "added")
        index = alice.fts_table_name("alice")
        self.assertIsNotNone(index)
        self.assertTrue(alice._table_exists(index))
        indexed = alice.conn.execute(f'SELECT COUNT(*) FROM "{index}"').fetchone()[0]
        alice_chunks = alice.conn.execute(
            "SELECT COUNT(*) FROM chunks WHERE namespace = 'alice'").fetchone()[0]
        self.assertEqual((indexed, alice_chunks), (1, 1))

        payload = alice.search("ledger purge", top_k=5)
        self.assertEqual(payload["backend"], "fts5")
        self.assertEqual([item["source"] for item in payload["results"]], ["notes/new.md"])
        self.assertEqual({item["namespace"] for item in payload["results"]}, {"alice"})
        # bob의 문서는 purge 이후에도 그대로 남아 있고 검색에도 나온다.
        self.assertEqual(bob.stats()["documents"], 1)
        self.assertEqual(bob.search("cache eviction")["results"][0]["source"],
                         "notes/bob-cache.md")


class NamespaceStatisticsTests(MemoryLayerCase):
    """BM25은 코퍼스 통계를 쓰므로, 색인을 공유하면 다른 namespace가 순위를 흔든다."""

    def test_alice_ranking_is_invariant_under_bob_inserts(self) -> None:
        tmp = tempfile.mkdtemp()
        db_path = os.path.join(tmp, "stats.sqlite3")
        alice = MemoryLayer(db_path, namespace="alice")
        bob = MemoryLayer(db_path, namespace="bob")

        def _cleanup() -> None:
            alice.close()
            bob.close()
            shutil.rmtree(tmp, ignore_errors=True)

        self.addCleanup(_cleanup)
        # 리뷰 재현: Alice는 alpha/beta/gamma 세 청크, 검색 순서는 [1, 2, 3].
        for source, text in (("a1", "alpha"), ("a2", "beta"), ("a3", "gamma")):
            alice.add_document(text, source)
        query = "alpha beta gamma"
        before = alice.search(query, top_k=3)
        before_order = [item["source"] for item in before["results"]]
        before_scores = [item["score"] for item in before["results"]]
        self.assertEqual(before_order, ["a1", "a2", "a3"])

        # 공용 색인 시절에는 Bob의 'alpha gamma' 두 단어가 Alice의 bm25 순위를 [2,1,3]
        # 으로 뒤집었다(문서 빈도/평균 길이 통계 오염). 이제는 색인이 분리되어 있다.
        bob.add_document("alpha gamma", "b1")
        after = alice.search(query, top_k=3)
        self.assertEqual([item["source"] for item in after["results"]], before_order)
        self.assertEqual([item["score"] for item in after["results"]], before_scores)
        self.assertEqual([item["bm25"] for item in after["results"]],
                         [item["bm25"] for item in before["results"]])
        self.assertTrue(all(item["namespace"] == "alice" for item in after["results"]))

        # 색인 자체가 namespace별로 나뉘어 있어 bm25가 다른 코퍼스를 보지 않는다.
        alice_index = alice.fts_table_name("alice")
        bob_index = bob.fts_table_name("bob")
        self.assertIsNotNone(alice_index)
        self.assertIsNotNone(bob_index)
        self.assertNotEqual(alice_index, bob_index)
        alice_rows = alice.conn.execute(f'SELECT COUNT(*) FROM "{alice_index}"').fetchone()[0]
        bob_rows = alice.conn.execute(f'SELECT COUNT(*) FROM "{bob_index}"').fetchone()[0]
        self.assertEqual((alice_rows, bob_rows), (3, 1))

    def test_stats_defaults_to_instance_namespace(self) -> None:
        tmp = tempfile.mkdtemp()
        db_path = os.path.join(tmp, "scoped.sqlite3")
        alice = MemoryLayer(db_path, namespace="alice")
        bob = MemoryLayer(db_path, namespace="bob")

        def _cleanup() -> None:
            alice.close()
            bob.close()
            shutil.rmtree(tmp, ignore_errors=True)

        self.addCleanup(_cleanup)
        alice.add_document("Alice keeps her retry budget in the ledger.", "notes/shared.md")
        bob.add_document("Bob keeps his retry budget in the ledger.", "notes/shared.md")

        scoped = alice.stats()
        self.assertEqual(scoped["scope"], "namespace")
        self.assertEqual(scoped["namespace"], "alice")
        self.assertEqual(scoped["documents"], 1)
        self.assertEqual(scoped["chunks"], 1)
        self.assertEqual(alice.stats("bob")["documents"], 1)
        self.assertEqual(alice.stats("bob")["namespace"], "bob")

    def test_database_stats_is_explicitly_named(self) -> None:
        tmp = tempfile.mkdtemp()
        db_path = os.path.join(tmp, "wide.sqlite3")
        alice = MemoryLayer(db_path, namespace="alice")
        bob = MemoryLayer(db_path, namespace="bob")

        def _cleanup() -> None:
            alice.close()
            bob.close()
            shutil.rmtree(tmp, ignore_errors=True)

        self.addCleanup(_cleanup)
        alice.add_document("Alice keeps her retry budget in the ledger.", "notes/shared.md")
        bob.add_document("Bob keeps his retry budget in the ledger.", "notes/shared.md")
        bob.add_document("Bob also keeps a cache eviction note.", "notes/bob-cache.md")

        wide = alice.database_stats()
        self.assertEqual(wide["scope"], "database")
        self.assertIsNone(wide["namespace"])
        self.assertEqual(wide["documents"], 3)
        self.assertEqual(wide["chunks"], 3)
        self.assertEqual(wide["namespaces"], 2)
        self.assertEqual(alice.stats(database_wide=True), wide)
        self.assertEqual(alice.stats()["documents"], 1)

    def test_purge_surfaces_incomplete_wal_truncation(self) -> None:
        tmp = tempfile.mkdtemp()
        db_path = os.path.join(tmp, "busy.sqlite3")
        layer = MemoryLayer(db_path, namespace="alice")

        def _cleanup() -> None:
            layer.close()
            shutil.rmtree(tmp, ignore_errors=True)

        self.addCleanup(_cleanup)
        for index in range(4):
            layer.add_document(
                f"Sealed ledger entry {index} records a retry budget decision. " * 30,
                f"sealed/{index}.md",
            )
        layer.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

        # 두 번째 연결이 읽기 스냅샷을 붙잡으면 TRUNCATE 체크포인트는 busy가 된다.
        reader = sqlite3.connect(db_path, isolation_level=None)
        self.addCleanup(reader.close)
        reader.execute("BEGIN")
        reader.execute("SELECT COUNT(*) FROM chunks").fetchone()

        result = layer.purge("alice")
        self.assertFalse(result["complete"])
        self.assertEqual(result["checkpoint"][0], 1)
        self.assertIn("busy=1", result["incomplete_reason"])
        self.assertIn("wal", result["incomplete_reason"])
        wal_path = db_path + "-wal"
        self.assertTrue(os.path.exists(wal_path))
        self.assertGreater(os.path.getsize(wal_path), 0)
        self.assertEqual(layer.database_stats()["documents"], 0)

        # 독자가 스냅샷을 놓은 뒤 다시 정리하면 잘라내기가 완료된다.
        reader.execute("COMMIT")
        self.assertEqual(layer.stats("alice")["documents"], 0)
        recovered = layer.purge("alice")
        self.assertTrue(recovered["complete"])
        self.assertEqual(recovered["checkpoint"], (0, 0, 0))


class IsolationTests(MemoryLayerCase):
    def test_namespaces_never_leak_within_one_database_file(self) -> None:
        tmp = tempfile.mkdtemp()
        db_path = os.path.join(tmp, "shared.sqlite3")
        alice = MemoryLayer(db_path, namespace="alice")
        bob = MemoryLayer(db_path, namespace="bob")

        def _cleanup() -> None:
            alice.close()
            bob.close()
            shutil.rmtree(tmp, ignore_errors=True)

        self.addCleanup(_cleanup)
        alice.add_document("Alice keeps her retry budget in the ledger.", "notes/shared.md")
        bob.add_document("Bob keeps his retry budget in the ledger.", "notes/shared.md")
        # stats() 기본은 인스턴스 namespace만 센다. 전체 값은 이름이 분명한 쪽에서 얻는다.
        self.assertEqual(alice.stats()["documents"], 1)
        self.assertEqual(alice.stats()["namespace"], "alice")
        self.assertEqual(alice.database_stats()["documents"], 2)

        alice_hits = alice.search("retry budget ledger", top_k=5)["results"]
        bob_hits = bob.search("retry budget ledger", top_k=5)["results"]
        self.assertTrue(alice_hits)
        self.assertTrue(bob_hits)
        self.assertEqual({item["namespace"] for item in alice_hits}, {"alice"})
        self.assertEqual({item["namespace"] for item in bob_hits}, {"bob"})
        self.assertTrue(all("Alice" in item["content"] for item in alice_hits))
        self.assertTrue(all("Bob" in item["content"] for item in bob_hits))

        cross = alice.search("retry budget ledger", top_k=5, namespace="bob")["results"]
        self.assertTrue(cross)
        self.assertEqual({item["namespace"] for item in cross}, {"bob"})

        # 저장 단계에서도 namespace가 실제로 분리되어 같은 source가 공존한다.
        self.assertEqual(
            alice.conn.execute("SELECT COUNT(*) FROM documents WHERE namespace = 'bob'").fetchone()[0],
            1,
        )
        with self.assertRaises(ValueError):
            alice.search("retry", namespace="  ")

    def test_purge_removes_rows_and_reclaims_space(self) -> None:
        tmp = tempfile.mkdtemp()
        db_path = os.path.join(tmp, "memory.sqlite3")
        layer = MemoryLayer(db_path, namespace="alice", max_documents=10)

        def _cleanup() -> None:
            layer.close()
            shutil.rmtree(tmp, ignore_errors=True)

        self.addCleanup(_cleanup)
        for index in range(6):
            layer.add_document(
                f"Ledger entry {index} records a retry budget decision with padding text. " * 40,
                f"notes/{index}.md",
            )
        layer.add_document("Bob separate memory about retry budget.", "notes/bob.md", namespace="bob")
        layer.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        before = os.path.getsize(db_path)
        alice_before = layer.stats()  # 기본은 인스턴스 namespace(alice)만 센다
        alice_index = layer.fts_table_name("alice")
        self.assertIsNotNone(alice_index)

        result = layer.purge("alice")

        self.assertTrue(result["vacuumed"])
        self.assertTrue(result["complete"])
        self.assertEqual(result["checkpoint"], (0, 0, 0))
        self.assertEqual(result["documents_deleted"], 6)
        self.assertEqual(result["chunks_deleted"], alice_before["chunks"])
        self.assertEqual(result["index_dropped"], alice_index)
        self.assertEqual(layer.stats("alice")["documents"], 0)
        self.assertEqual(layer.stats("alice")["chunks"], 0)
        self.assertEqual(layer.stats()["documents"], 0)
        self.assertEqual(layer.database_stats()["documents"], 1)
        self.assertIsNone(layer.fts_table_name("alice"))
        self.assertEqual(layer.search("ledger entry retry", namespace="alice")["results"], [])
        self.assertTrue(layer.search("retry budget", namespace="bob")["results"])
        after = os.path.getsize(db_path)
        self.assertLess(after, before)


class BudgetTests(MemoryLayerCase):
    def test_oversized_document_raises_instead_of_truncating(self) -> None:
        layer = MemoryLayer(":memory:", max_document_chars=100)
        self.addCleanup(layer.close)
        layer.add_document("short document about retries", "short.md")
        oversized = "retries " * 40
        self.assertGreater(len(oversized), 100)

        with self.assertRaises(DocumentTooLargeError) as context:
            layer.add_document(oversized, "big.md")
        self.assertIn("100", str(context.exception))
        self.assertEqual(layer.stats()["documents"], 1)
        self.assertEqual(layer.search("retries")["results"][0]["source"], "short.md")

    def test_document_budget_raises_on_new_document(self) -> None:
        layer = MemoryLayer(":memory:", max_documents=2)
        self.addCleanup(layer.close)
        layer.add_document("first document about retries", "one.md")
        layer.add_document("second document about retries", "two.md")
        layer.add_document("second document about retries", "two.md")

        with self.assertRaises(BudgetExceededError):
            layer.add_document("third document about retries", "three.md")
        self.assertEqual(layer.stats()["documents"], 2)


class ModuleContractTests(unittest.TestCase):
    def test_docstring_states_lexical_only_without_benchmark_claims(self) -> None:
        from engine import memory_layer

        docstring = memory_layer.__doc__ or ""
        self.assertIn("렉시컬", docstring)
        self.assertIn("Reciprocal Rank Fusion", docstring)
        with open(memory_layer.__file__, encoding="utf-8") as handle:
            source = handle.read()
        for banned in ("45.06", "41.79", "InvMem", "state of the art", "outperforms"):
            self.assertNotIn(banned, source)

    def test_public_exports_are_declared(self) -> None:
        from engine import memory_layer

        for name in (
            "MemoryLayer",
            "chunk_text",
            "BudgetExceededError",
            "DocumentTooLargeError",
        ):
            self.assertIn(name, memory_layer.__all__)


if __name__ == "__main__":
    unittest.main()
