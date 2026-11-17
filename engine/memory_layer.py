"""메모리 계층: 단일 SQLite 파일 위의 렉시컬(lexical) 메모리 저장/검색.

이 모듈은 **렉시컬 검색만** 제공한다. FTS5 BM25 순위와 질의-청크 토큰 겹침(overlap)
순위를 Reciprocal Rank Fusion(k=60)으로 합칠 뿐이며, 의미 검색이나 내장 임베딩 모델은
없다. 외부 서비스, 벡터 DB, 네트워크 호출은 쓰지 않는다. 호출자가 로컬 임베더
``embed(text) -> list[float]``를 주입했을 때만 코사인 유사도가 세 번째 랭커로 합류하고,
결과의 ``mode``가 실제 경로(``lexical`` / ``lexical+embedding``)를 밝힌다.

스키마(단일 SQLite 파일): ``documents``(doc_id, namespace, source, content_hash,
ingested_at, size_chars, chunk_count, metadata_json), ``chunks``(chunk_id, doc_id,
namespace, ordinal, content, char_start, char_end, embedding_json). FTS5 색인은
namespace마다 하나씩 따로 둔다: ``chunks_fts_<sha256(namespace) 앞 32자>``(이름은
해시라 SQL 식별자로 안전하다). BM25는 문서
빈도/길이 같은 코퍼스 통계를 쓰므로 색인을 합치면 다른 사용자의 어휘 분포가 이 사용자의
점수와 RRF 순서를 바꾼다(정보 누출). 색인을 namespace별로 나눠 bm25가 그 namespace의
코퍼스만 보게 한다. 색인 테이블은 처음 쓰일 때 만들고 ``purge``에서 함께 DROP한다.

청킹 정책(고정 창): 공백 분리 단어 120개를 한 창으로 보고 24개를 겹친다. 모델
토크나이저가 아닌 근사치이며 영문 산문 기준 대략 480자 규모의 창이다. 겹침(overlap)
신호는 소문자 토큰의 정확한 집합 일치이고, FTS5 쪽은 fts5_memory의 질의 살균 결과에
비ASCII 토큰만 접두 매칭을 붙여 조사가 붙은 한국어 표기와 맞춘다.

``capabilities()``는 선택된 경로(``backend``)와 별도로 빌드가 실제로 FTS5를 지원하는지
(``fts5_available``, 임시 테이블 생성으로 매번 확인)와 강제 폴백 여부
(``forced_like_fallback``)를 구분해 알린다. namespace는 저장/검색 범위 표시이며
인증 경계가 아니다. 다른 namespace를 읽으려면 호출자가 그 이름을 명시해야 하고,
한 번의 검색 결과는 언제나 단일 namespace로만 구성된다.

``stats()``는 이 인스턴스의 namespace만 센다. 데이터베이스 전체 통계가 필요하면 이름이
분명한 ``database_stats()``나 ``stats(database_wide=True)``를 쓴다. ``purge()``는
삭제·VACUUM 뒤 WAL 체크포인트 결과를 확인해, 다른 연결이 읽기 스냅샷을 잡고 있어
잘라내지 못했으면 ``complete=False``와 ``checkpoint`` 결과를 결과에 담아 알린다.

예산 초과는 본문을 자르지 않고 ``BudgetExceededError``(DB 파일 전체 문서 수 상한
``max_documents``) 또는 ``DocumentTooLargeError``(문서 하나의 문자 수 상한
``max_document_chars``)로 거부한다. ``score``는 확률이 아니라 RRF 순위 합
``1/(k+rank)``이며, 이 모듈은 어떤 벤치마크 점수도 주장하지 않는다.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import math
import re
import sqlite3
from collections.abc import Callable, Iterator, Mapping, Sequence
from datetime import datetime, timezone
from typing import Any, Optional

from .fts5_memory import sanitize_fts5_query

RRF_K = 60
CHUNK_TOKENS = 120
CHUNK_OVERLAP_TOKENS = 24
FTS_TABLE_PREFIX = "chunks_fts_"
SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    doc_id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL,
    source TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    size_chars INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (namespace, source)
);
CREATE TABLE IF NOT EXISTS chunks (
    chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
    namespace TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    content TEXT NOT NULL,
    char_start INTEGER NOT NULL,
    char_end INTEGER NOT NULL,
    embedding_json TEXT,
    UNIQUE (doc_id, ordinal)
);
CREATE INDEX IF NOT EXISTS chunks_ns ON chunks (namespace);
CREATE TABLE IF NOT EXISTS fts_indexes (
    namespace TEXT PRIMARY KEY,
    table_name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);
"""
_WORD = re.compile(r"\S+")
_TERM = re.compile(r"[A-Za-z0-9_가-힣]+")
Embedder = Callable[[str], Sequence[float]]

__all__ = ["RRF_K", "CHUNK_TOKENS", "CHUNK_OVERLAP_TOKENS", "MemoryLayer", "MemoryLayerError",
           "BudgetExceededError", "DocumentTooLargeError", "EmbeddingError", "chunk_text"]


class MemoryLayerError(Exception):
    """메모리 계층 공통 예외."""


class BudgetExceededError(MemoryLayerError):
    """문서 수 상한(max_documents) 초과."""


class DocumentTooLargeError(MemoryLayerError):
    """문서 크기 상한(max_document_chars) 초과. 본문을 자르지 않고 거부한다."""


class EmbeddingError(MemoryLayerError):
    """주입된 임베더가 쓸 수 없는 값을 반환했을 때."""


def _terms(text: str) -> list[str]:
    """겹침 신호용 소문자 토큰. FTS5 살균은 fts5_memory의 함수를 재사용한다."""
    return [term.lower() for term in _TERM.findall(text or "")]


def _like(term: str) -> str:
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _cosine(left: Sequence[float], right: Sequence[float]) -> float:
    norm = math.sqrt(sum(a * a for a in left)) * math.sqrt(sum(b * b for b in right))
    return 0.0 if norm == 0.0 else sum(a * b for a, b in zip(left, right)) / norm


def chunk_text(text: str) -> list[dict[str, Any]]:
    """고정 창 청킹: 단어 120개 창, 24개 겹침. 문자 구간은 원문 기준이다."""
    spans = [(match.start(), match.end()) for match in _WORD.finditer(text)]
    chunks: list[dict[str, Any]] = []
    start = 0
    while start < len(spans):
        end = min(start + CHUNK_TOKENS, len(spans))
        char_start, char_end = spans[start][0], spans[end - 1][1]
        chunks.append({"ordinal": len(chunks), "content": text[char_start:char_end],
                       "char_start": char_start, "char_end": char_end})
        if end == len(spans):
            return chunks
        start += CHUNK_TOKENS - CHUNK_OVERLAP_TOKENS
    return chunks


class MemoryLayer:
    """namespace로 격리된 문서 저장소와 렉시컬 검색기.

    ``search``는 BM25(또는 LIKE 폴백) 순위와 토큰 겹침 순위를 RRF(k=60)로 합치고,
    임베더가 주입된 경우에만 코사인 순위를 더한다. 결과의 ``mode``/``backend``와
    ``capabilities()``가 어떤 경로가 그 결과를 만들었는지 알려준다.
    """

    def __init__(self, db_path: str = ":memory:", *, namespace: str = "default",
                 embedder: Optional[Embedder] = None, max_documents: int = 500,
                 max_document_chars: int = 200_000, force_like_fallback: bool = False,
                 candidate_limit: int = 50, scan_limit: int = 2_000) -> None:
        if max_documents <= 0 or max_document_chars <= 0:
            raise ValueError("budgets must be positive")
        self.db_path, self.embedder = db_path, embedder
        self.namespace = self._namespace(namespace)
        self.max_documents, self.max_document_chars = max_documents, max_document_chars
        self.candidate_limit, self.scan_limit = max(int(candidate_limit), 1), max(int(scan_limit), 1)
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self.conn.isolation_level = None
        self.conn.execute("PRAGMA foreign_keys = ON")
        if db_path != ":memory:":
            self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.executescript(SCHEMA)
        self._dim: Optional[int] = None
        self._forced_like = bool(force_like_fallback)
        # 빌드의 실제 FTS5 지원 여부는 임시 테이블 생성으로 확인한다(파일에 흔적을 남기지 않음).
        self._fts5_supported = self._probe_fts5()
        self._fts_names: dict[str, str] = {}
        self._drop_legacy_shared_index()
        if self._fts5_supported:
            # 구버전/LIKE 모드로 쌓인 namespace의 색인을 한 번 채운다. 색인의 진실
            # 원천은 ``chunks``라서 재실행해도 중복되지 않는다.
            for row in self.conn.execute("SELECT DISTINCT namespace FROM chunks").fetchall():
                self._ensure_fts(str(row["namespace"]))
        # 지원되면 색인은 항상 유지하고(일관성), 강제 폴백일 때만 읽기를 LIKE로 내린다.
        self._fts = self._fts5_supported and not self._forced_like

    def _probe_fts5(self) -> bool:
        """FTS5 사용 가능 여부를 실제로 시험한다. temp 스키마만 쓰고 즉시 지운다."""
        try:
            self.conn.execute("CREATE VIRTUAL TABLE temp.__memory_layer_probe USING fts5(x)")
        except sqlite3.OperationalError:
            return False
        self.conn.execute("DROP TABLE temp.__memory_layer_probe")
        return True

    def _drop_legacy_shared_index(self) -> None:
        """이전 버전의 공용 색인은 bm25 통계를 namespace 사이로 섞으므로 제거한다.

        색인의 진실 원천은 ``chunks`` 테이블이므로, namespace별 색인은 처음 쓰일 때
        ``chunks``에서 다시 채워진다.
        """
        if not self._fts5_supported:
            return
        legacy = self.conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'"
        ).fetchone()[0]
        if legacy:
            self.conn.execute("DROP TABLE chunks_fts")

    def fts_table_name(self, namespace: str) -> Optional[str]:
        """해당 namespace의 FTS5 색인 테이블 이름. 등록이 없거나 테이블이 사라졌으면 None.

        ``fts_indexes`` 등록 행만 보고 이름을 돌려주면, 다른 연결이 색인을 지운 뒤에도
        존재하지 않는 테이블 이름을 참 진실처럼 노출하게 된다. 그래서 실제 존재까지
        확인한 이름만 돌려준다(재건은 다음 쓰기/검색에서 ``_ensure_fts``가 맡는다).
        """
        if not self._fts5_supported:
            return None
        row = self.conn.execute(
            "SELECT table_name FROM fts_indexes WHERE namespace = ?", (self._namespace(namespace),)
        ).fetchone()
        if row is None:
            return None
        name = str(row["table_name"])
        return name if self._table_exists(name) else None

    def _ensure_fts(self, ns: str) -> Optional[str]:
        """namespace 전용 색인을 확보하고, 처음 등록될 때만 ``chunks``에서 채운다.

        색인의 진실 원천은 항상 ``chunks`` 테이블이다. ``self._fts_names`` 캐시는
        참고용일 뿐이며, 쓰기 직전에는 언제나 ``sqlite_master``로 테이블 존재를 다시
        확인한다. 다른 연결이나 직접 ``DROP TABLE``로 색인이 사라졌으면 ``chunks``에서
        다시 만들어 ``fts_indexes``에 재등록한 뒤 그대로 진행한다.
        """
        if not self._fts5_supported:
            return None
        row = self.conn.execute(
            "SELECT table_name FROM fts_indexes WHERE namespace = ?", (ns,)).fetchone()
        if row is not None:
            name = str(row["table_name"])
            if self._table_exists(name):
                self._fts_names[ns] = name
                return name
            # 등록만 남고 테이블이 사라진 경우: 잔여 파편을 지우고 아래에서 다시 만든다.
            self.conn.execute(f'DROP TABLE IF EXISTS "{name}"')
        else:
            cached = self._fts_names.get(ns)
            if cached is not None and self._table_exists(cached):
                # 등록 행만 유실된 경우(외부 DML): 남아 있는 테이블을 그대로 다시 등록한다.
                self.conn.execute(
                    "INSERT OR REPLACE INTO fts_indexes (namespace, table_name, created_at) "
                    "VALUES (?, ?, ?)", (ns, cached, self._now()))
                return cached
            self._fts_names.pop(ns, None)
            name = self._fts_name(ns)
            self.conn.execute(f'DROP TABLE IF EXISTS "{name}"')
        self.conn.execute(f'CREATE VIRTUAL TABLE "{name}" USING fts5('
                          "content, tokenize = 'porter unicode61')")
        self.conn.execute("INSERT OR REPLACE INTO fts_indexes (namespace, table_name, created_at) "
                          "VALUES (?, ?, ?)", (ns, name, self._now()))
        # 새 색인은 기존 청크(LIKE 모드/구버전/색인 유실 후)로 채운다.
        self.conn.execute(f'INSERT INTO "{name}" (rowid, content) '
                          "SELECT chunk_id, content FROM chunks WHERE namespace = ?", (ns,))
        self._fts_names[ns] = name
        return name

    def _table_exists(self, name: str) -> bool:
        """색인 테이블 존재 확인. sqlite_master 조회는 인덱스로 처리되는 저비용 질의다."""
        return self.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)).fetchone(
        ) is not None

    def _read_index(self, ns: str) -> Optional[str]:
        """읽기 경로에서 쓸 색인 이름. 등록된 색인이 없으면 새로 만들지 않고 None.

        등록은 있는데 테이블만 사라졌으면(다른 연결의 DROP) ``chunks``에서 재건한다.
        등록도 없고 청크도 없으면(다른 연결의 purge) 캐시를 버리고 None을 돌려준다.
        """
        if not self._fts5_supported:
            return None
        row = self.conn.execute(
            "SELECT table_name FROM fts_indexes WHERE namespace = ?", (ns,)).fetchone()
        if row is not None:
            name = str(row["table_name"])
            if self._table_exists(name):
                self._fts_names[ns] = name
                return name
            return self._ensure_fts(ns)
        self._fts_names.pop(ns, None)
        if self.conn.execute("SELECT 1 FROM chunks WHERE namespace = ? LIMIT 1",
                             (ns,)).fetchone() is None:
            return None
        return self._ensure_fts(ns)

    @staticmethod
    def _fts_name(ns: str) -> str:
        """namespace 전용 색인 이름: 해시(영숫자만)라 SQL 식별자로 안전하다.

        128비트를 쓰므로 서로 다른 namespace가 같은 이름으로 접힐 가능성은 무시할 수
        있고, 실제로 이름 충돌이 나면 ``fts_indexes.table_name`` UNIQUE가 막는다.
        """
        return f"{FTS_TABLE_PREFIX}{hashlib.sha256(ns.encode('utf-8')).hexdigest()[:32]}"

    def capabilities(self) -> dict[str, Any]:
        """빌드의 FTS5 지원과 이 인스턴스의 선택 경로를 구분해 노출한다."""
        return {"backend": "fts5" if self._fts else "like",
                "fts5_available": self._fts5_supported,
                "forced_like_fallback": self._forced_like,
                "tokenizer": "porter unicode61" if self._fts else None,
                "embedding_enabled": self.embedder is not None, "rrf_k": RRF_K,
                "chunk_tokens": CHUNK_TOKENS, "chunk_overlap_tokens": CHUNK_OVERLAP_TOKENS}

    @contextlib.contextmanager
    def _tx(self) -> Iterator[None]:
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise
        self.conn.execute("COMMIT")

    # -------------------------------------------------------------- ingestion
    def add_document(self, text: str, source: str, metadata: Optional[Mapping[str, Any]] = None,
                     namespace: Optional[str] = None) -> dict[str, Any]:
        """문서를 청킹해 저장한다. status: added / skipped-duplicate / updated.

        같은 (namespace, source) 문서의 본문 해시가 같으면 아무것도 쓰지 않고
        skipped-duplicate를 돌려준다. 해시가 다르면 기존 청크/FTS 행을 지우고 다시
        써서 updated를 돌려준다. 상한 초과는 본문을 자르지 않고 예외로 거부한다.
        """
        if not isinstance(text, str):
            raise TypeError("text must be a str")
        if not isinstance(source, str) or not source:
            raise ValueError("source must be a non-empty str")
        if not text.strip():
            raise ValueError("text must not be empty")
        ns = self._namespace(namespace if namespace is not None else self.namespace)
        if len(text) > self.max_document_chars:
            raise DocumentTooLargeError(
                f"document has {len(text)} chars, cap is {self.max_document_chars}")
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        meta = self._meta(metadata)
        row = self.conn.execute("SELECT doc_id, content_hash, chunk_count FROM documents "
                                "WHERE namespace = ? AND source = ?", (ns, source)).fetchone()
        if row is not None and row["content_hash"] == digest:
            stored_vectors = self.conn.execute(
                "SELECT COUNT(*) FROM chunks WHERE doc_id = ? AND embedding_json IS NOT NULL",
                (row["doc_id"],)).fetchone()[0]
            return self._result("skipped-duplicate", row["doc_id"], ns, source, digest,
                                row["chunk_count"], stored_vectors > 0)
        chunks = chunk_text(text)
        vectors = [self._embed(chunk["content"]) for chunk in chunks] if self.embedder else None
        with self._tx():
            fts = self._ensure_fts(ns)
            if row is None:
                total = self.conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
                if total >= self.max_documents:
                    raise BudgetExceededError(
                        f"{total} documents already stored, cap is {self.max_documents}")
                cursor = self.conn.execute(
                    "INSERT INTO documents (namespace, source, content_hash, ingested_at, "
                    "size_chars, chunk_count, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (ns, source, digest, self._now(), len(text), len(chunks), meta))
                doc_id, status = cursor.lastrowid, "added"
            else:
                doc_id, status = row["doc_id"], "updated"
                self._drop_chunks(doc_id, ns)
                self.conn.execute(
                    "UPDATE documents SET content_hash = ?, ingested_at = ?, size_chars = ?, "
                    "chunk_count = ?, metadata_json = ? WHERE doc_id = ?",
                    (digest, self._now(), len(text), len(chunks), meta, doc_id))
            for index, chunk in enumerate(chunks):
                cursor = self.conn.execute(
                    "INSERT INTO chunks (doc_id, namespace, ordinal, content, char_start, "
                    "char_end, embedding_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (doc_id, ns, chunk["ordinal"], chunk["content"], chunk["char_start"],
                     chunk["char_end"], json.dumps(vectors[index]) if vectors else None))
                if self._fts5_supported:
                    self.conn.execute(f'INSERT INTO "{fts}" (rowid, content) VALUES (?, ?)',
                                      (cursor.lastrowid, chunk["content"]))
        return self._result(status, doc_id, ns, source, digest, len(chunks), vectors is not None)

    def _result(self, status: str, doc_id: Any, ns: str, source: str, digest: str,
                chunks: Any, embedded: bool) -> dict[str, Any]:
        return {"status": status, "doc_id": int(doc_id), "namespace": ns, "source": source,
                "content_hash": digest, "chunks": int(chunks), "embedding": embedded,
                "backend": self.capabilities()["backend"]}

    def _drop_chunks(self, doc_id: Any, ns: str) -> None:
        # 색인이 세션 중에 사라졌더라도 실패하지 않도록 존재를 확인하며 확보한다.
        # 재건된 색인에는 이 문서의 청크도 백필되어 있으므로 아래 DELETE가 그대로 정리한다.
        fts = self._ensure_fts(ns) if self._fts5_supported else None
        if fts is not None:
            self.conn.execute(
                f'DELETE FROM "{fts}" WHERE rowid IN '
                "(SELECT chunk_id FROM chunks WHERE doc_id = ?)", (doc_id,))
        self.conn.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))

    # --------------------------------------------------------------- retrieval
    def search(self, query: str, top_k: int = 5,
               namespace: Optional[str] = None) -> dict[str, Any]:
        """렉시컬 검색. BM25(또는 LIKE) 순위와 토큰 겹침 순위를 RRF(k=60)로 합친다.

        ``mode``는 lexical 또는 lexical+embedding, ``backend``는 fts5 또는 like,
        ``results[].ranks``는 각 신호의 1-기준 순위다. 점수는 ``sum(1/(60+rank))``
        이며 코사인 신호는 주입된 로컬 임베더에서만 나온다.
        """
        if not isinstance(query, str):
            raise TypeError("query must be a str")
        if top_k <= 0:
            raise ValueError("top_k must be positive")
        ns = self._namespace(namespace if namespace is not None else self.namespace)
        terms = _terms(query)
        match = self._match(query) if self._fts else ""
        payload: dict[str, Any] = {
            "query": query, "namespace": ns, "mode": "lexical",
            "backend": self.capabilities()["backend"], "rrf_k": RRF_K,
            "embedding_used": False, "capabilities": self.capabilities(), "results": [],
        }
        if not terms or (self._fts and not match):
            return payload
        limit = max(self.candidate_limit, top_k)
        embedding, compared = self._rank_embedding(query, ns, limit)
        lexical, overlap = self._rank_lexical_and_overlap(match, terms, ns, limit)
        fused: dict[int, dict[str, Any]] = {}
        for name, ranking in (("lexical", lexical), ("overlap", overlap),
                              ("embedding", embedding)):
            for rank, item in enumerate(ranking, 1):
                entry = fused.setdefault(item["chunk_id"], {
                    "score": 0.0, "ranks": {}, "bm25": None, "term_frequency": None,
                    "overlap": None, "embedding_similarity": None})
                entry["score"] += 1.0 / (RRF_K + rank)
                entry["ranks"][name] = rank
                for key, value in item.items():
                    if key != "chunk_id":
                        entry[key] = value
        ordered = sorted(fused.items(), key=lambda pair: (-pair[1]["score"], pair[0]))[:top_k]
        rows = self._fetch([chunk_id for chunk_id, _ in ordered], ns)
        for chunk_id, entry in ordered:
            row = rows.get(chunk_id)
            if row is None:
                continue
            payload["results"].append({
                "chunk_id": chunk_id, "doc_id": int(row["doc_id"]), "source": row["source"],
                "namespace": row["namespace"], "ordinal": int(row["ordinal"]),
                "char_span": [int(row["char_start"]), int(row["char_end"])],
                "content": row["content"], "score": entry["score"], "ranks": entry["ranks"],
                "bm25": entry["bm25"], "term_frequency": entry["term_frequency"],
                "overlap": entry["overlap"], "embedding_similarity": entry["embedding_similarity"],
                "metadata": json.loads(row["metadata_json"])})
        payload["embedding_used"] = compared
        payload["mode"] = "lexical+embedding" if compared else "lexical"
        return payload

    def _match(self, query: str) -> str:
        """fts5_memory의 살균 결과를 그대로 쓰되, 비ASCII 토큰에만 접두 매칭(*)을 붙인다.

        unicode61은 한글을 공백 기준으로만 나누므로 조사가 붙은 본문("롤백은")과
        질의("롤백")가 어긋난다. 한국어 형태소 분석기 없이 이 간극을 메우는 최소한의
        보정이며, ASCII 토큰의 매칭 범위는 바꾸지 않는다.
        """
        sanitized = sanitize_fts5_query(query, joiner="OR")
        if not sanitized:
            return ""
        parts = []
        for part in sanitized.split(" OR "):
            token = part.strip().strip('"')
            parts.append(f'"{token}"*' if any(ord(ch) > 127 for ch in token) else part)
        return " OR ".join(parts)

    def _rank_lexical_and_overlap(self, match: str, terms: list[str], ns: str, limit: int
                                  ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """신호 1과 2. LIKE 후보 집합은 한 번만 읽고 두 신호가 함께 쓴다.

        신호 1(lexical)은 namespace 전용 FTS5 색인의 BM25(작을수록 좋음)라서 다른
        namespace의 문서 통계가 끼어들지 않는다. 폴백 백엔드에서는 같은 후보의 용어
        빈도다. 신호 2(overlap)는 질의 토큰 중 청크에 등장한 비율이며, LIKE는 후보를
        좁히는 상위 집합 필터일 뿐 점수에 쓰이지 않는다.
        """
        unique = sorted(set(terms))
        candidates = self._candidates(unique, ns)
        # 검색은 이미 존재하는 색인만 쓴다(읽기 도중에 새 namespace를 만들지 않는다).
        # 다만 등록된 색인의 테이블이 사라졌으면 청크에서 다시 세운 뒤 계속한다.
        fts = self._read_index(ns) if self._fts else None
        if fts is not None:
            rows = self.conn.execute(
                f'SELECT rowid AS chunk_id, bm25("{fts}") AS bm25 FROM "{fts}" '
                f'WHERE "{fts}" MATCH ? ORDER BY bm25("{fts}"), rowid LIMIT ?',
                (match, limit)).fetchall()
            lexical = [{"chunk_id": int(row["chunk_id"]), "bm25": float(row["bm25"])}
                       for row in rows]
        else:
            frequency = [(float(sum(row["content"].lower().count(term) for term in unique)),
                          int(row["chunk_id"])) for row in candidates]
            frequency.sort(key=lambda pair: (-pair[0], pair[1]))
            lexical = [{"chunk_id": cid, "term_frequency": freq}
                       for freq, cid in frequency[:limit]]

        scored: list[tuple[float, int]] = []
        for row in candidates:
            present = set(_terms(row["content"]))
            hits = sum(1 for term in unique if term in present)
            if hits:
                scored.append((hits / len(unique), int(row["chunk_id"])))
        scored.sort(key=lambda pair: (-pair[0], pair[1]))
        overlap = [{"chunk_id": cid, "overlap": score} for score, cid in scored[:limit]]
        return lexical, overlap

    def _candidates(self, terms: list[str], ns: str) -> list[sqlite3.Row]:
        """LIKE로 후보를 추린다. 폴백 백엔드에서는 점수 근거이기도 하다."""
        clause = " OR ".join("content LIKE ? ESCAPE '\\'" for _ in terms)
        return self.conn.execute(
            f"SELECT chunk_id, content FROM chunks WHERE namespace = ? AND ({clause}) LIMIT ?",
            (ns, *(_like(term) for term in terms), self.scan_limit)).fetchall()

    def _rank_embedding(self, query: str, ns: str,
                        limit: int) -> tuple[list[dict[str, Any]], bool]:
        """신호 3(선택): 주입된 로컬 임베더의 코사인 유사도. 양수만 순위에 넣는다."""
        if self.embedder is None:
            return [], False
        query_vector = self._embed(query)
        rows = self.conn.execute(
            "SELECT chunk_id, embedding_json FROM chunks "
            "WHERE namespace = ? AND embedding_json IS NOT NULL LIMIT ?",
            (ns, self.scan_limit)).fetchall()
        scored: list[tuple[float, int]] = []
        compared = 0
        for row in rows:
            vector = json.loads(row["embedding_json"])
            if len(vector) != len(query_vector):
                continue
            compared += 1
            similarity = _cosine(query_vector, vector)
            if similarity > 0.0:
                scored.append((similarity, int(row["chunk_id"])))
        scored.sort(key=lambda pair: (-pair[0], pair[1]))
        return ([{"chunk_id": cid, "embedding_similarity": sim} for sim, cid in scored[:limit]],
                compared > 0)

    def _fetch(self, chunk_ids: list[int], ns: str) -> dict[int, sqlite3.Row]:
        if not chunk_ids:
            return {}
        marks = ", ".join("?" for _ in chunk_ids)
        rows = self.conn.execute(
            "SELECT chunks.chunk_id, chunks.doc_id, chunks.namespace, chunks.ordinal, "
            "chunks.content, chunks.char_start, chunks.char_end, documents.source, "
            "documents.metadata_json FROM chunks JOIN documents USING (doc_id) "
            f"WHERE chunks.chunk_id IN ({marks}) AND chunks.namespace = ?",
            (*chunk_ids, ns)).fetchall()
        return {int(row["chunk_id"]): row for row in rows}

    # -------------------------------------------------------- isolation/purge
    def purge(self, namespace: str) -> dict[str, Any]:
        """해당 namespace의 색인/청크/문서 행을 실제로 지우고 VACUUM한다.

        삭제 뒤 ``PRAGMA wal_checkpoint(TRUNCATE)`` 결과를 반드시 확인한다. 다른 연결이
        읽기 스냅샷을 붙잡고 있으면 체크포인트는 busy(첫 값 1)를 돌려주며, 그때는 WAL에
        삭제 전 내용이 남는다. 이 경우 ``complete=False``와 체크포인트 튜플을 결과에 담아
        조용히 성공으로 보고하지 않는다(예외는 던지지 않는다: 행 삭제 자체는 완료됨).
        """
        ns = self._namespace(namespace)
        names: list[str] = []
        if self._fts5_supported:
            names.append(self._fts_name(ns))
            row = self.conn.execute("SELECT table_name FROM fts_indexes WHERE namespace = ?",
                                    (ns,)).fetchone()
            if row is not None and str(row["table_name"]) not in names:
                names.append(str(row["table_name"]))
        fts = names[0] if names else None
        with self._tx():
            for name in names:
                if self._table_exists(name):
                    self.conn.execute(f'DROP TABLE IF EXISTS "{name}"')
            self.conn.execute("DELETE FROM fts_indexes WHERE namespace = ?", (ns,))
            self._fts_names.pop(ns, None)
            chunks = self.conn.execute("DELETE FROM chunks WHERE namespace = ?", (ns,))
            documents = self.conn.execute("DELETE FROM documents WHERE namespace = ?", (ns,))
        self.conn.execute("VACUUM")
        checkpoint = self._checkpoint()
        result: dict[str, Any] = {
            "namespace": ns,
            "documents_deleted": documents.rowcount,
            "chunks_deleted": chunks.rowcount,
            "index_dropped": fts,
            "vacuumed": True,
            "checkpoint": checkpoint,
            "complete": True,
        }
        if checkpoint is not None and checkpoint[0] != 0:
            result["complete"] = False
            result["incomplete_reason"] = (
                "wal_checkpoint(TRUNCATE) reported busy="
                f"{checkpoint[0]} (log={checkpoint[1]}, checkpointed={checkpoint[2]}); "
                "pre-purge pages may still reside in the -wal file until readers release it")
        return result

    def _checkpoint(self) -> Optional[tuple[int, int, int]]:
        """WAL 체크포인트를 실행하고 (busy, log, checkpointed)를 돌려준다.

        메모리 DB나 WAL이 아닌 파일에서는 해당 PRAGMA가 의미가 없으므로 결과가 없으면
        None을 돌려준다. 대기 시간은 0으로 두어 다른 연결이 붙잡고 있으면 기다리지 않고
        곧바로 busy를 보고하게 한다(삭제는 이미 끝났으므로 재시도 가치가 없다).
        """
        if self.db_path == ":memory:":
            return None
        previous = int(self.conn.execute("PRAGMA busy_timeout").fetchone()[0])
        self.conn.execute("PRAGMA busy_timeout = 0")
        try:
            row = self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        finally:
            self.conn.execute(f"PRAGMA busy_timeout = {previous}")
        if row is None:
            return None
        return (int(row[0]), int(row[1]), int(row[2]))

    def stats(self, namespace: Optional[str] = None, database_wide: bool = False) -> dict[str, Any]:
        """문서/청크 개수. 기본은 이 인스턴스의 namespace만 센다.

        다른 namespace의 양까지 포함한 전체 값이 필요하면 ``database_stats()``를 쓰거나
        ``database_wide=True``를 명시한다.
        """
        if database_wide:
            return self.database_stats()
        ns = self._namespace(namespace if namespace is not None else self.namespace)
        return self._counts(ns)

    def database_stats(self) -> dict[str, Any]:
        """데이터베이스 파일 전체(모든 namespace) 문서/청크 개수. 이름으로 범위를 밝힌다."""
        documents = self.conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
        chunks = self.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        return {
            "scope": "database",
            "namespace": None,
            "documents": int(documents),
            "chunks": int(chunks),
            "namespaces": int(
                self.conn.execute("SELECT COUNT(DISTINCT namespace) FROM documents").fetchone()[0]
            ),
            "backend": self.capabilities()["backend"],
        }

    def _counts(self, ns: str) -> dict[str, Any]:
        documents = self.conn.execute(
            "SELECT COUNT(*) FROM documents WHERE namespace = ?", (ns,)).fetchone()[0]
        chunks = self.conn.execute(
            "SELECT COUNT(*) FROM chunks WHERE namespace = ?", (ns,)).fetchone()[0]
        return {"scope": "namespace", "namespace": ns, "documents": int(documents),
                "chunks": int(chunks), "backend": self.capabilities()["backend"]}

    # ------------------------------------------------------------- embedding
    def _embed(self, text: str) -> tuple[float, ...]:
        if self.embedder is None:
            raise EmbeddingError("no embedder configured")
        try:
            vector = tuple(float(value) for value in self.embedder(text))
        except (TypeError, ValueError) as exc:
            raise EmbeddingError(f"embedder must return floats: {exc}") from exc
        if not vector:
            raise EmbeddingError("embedder returned an empty vector")
        if self._dim is None:
            self._dim = len(vector)
        elif len(vector) != self._dim:
            raise EmbeddingError(f"embedding size changed: {len(vector)} != {self._dim}")
        return vector

    # ---------------------------------------------------------------- helpers
    @staticmethod
    def _namespace(namespace: Any) -> str:
        if not isinstance(namespace, str) or not namespace.strip():
            raise ValueError("namespace must be a non-empty str")
        return namespace.strip()

    @staticmethod
    def _meta(metadata: Optional[Mapping[str, Any]]) -> str:
        if metadata is None:
            return "{}"
        if not isinstance(metadata, Mapping):
            raise MemoryLayerError("metadata must be a mapping")
        try:
            return json.dumps(metadata, ensure_ascii=False, sort_keys=True)
        except TypeError as exc:
            raise MemoryLayerError(f"metadata must be JSON-serialisable: {exc}") from exc

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    def close(self) -> None:
        self.conn.close()
