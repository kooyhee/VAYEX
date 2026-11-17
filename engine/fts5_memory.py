import hashlib
import json
import re
import sqlite3
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Union

from .file_tools import resolve_within, apply_edits, hash_bytes, HashMismatchError

# FTS5 구문 에러를 유발하는 구두점/연산자 제거용 토크나이저: 영문/숫자/밑줄/한글만 보존
_TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_가-힣]+")


def sanitize_fts5_query(query: str, joiner: str = "OR") -> str:
    """사용자 질의 또는 코드 텍스트에서 안전한 FTS5 MATCH 표현식을 생성한다.

    구두점(`:`, `/`, `"`, `*`, `^`, `-` 등)으로 인한 `sqlite3.OperationalError: fts5: syntax error`를
    방지하기 위해 안전한 토큰만 추출한 뒤 각 토큰을 큰따옴표로 감싸 ``joiner``로 연결한다.
    토큰이 전혀 없으면 빈 문자열을 반환한다.
    """
    if not query:
        return ""
    tokens = _TOKEN_PATTERN.findall(query)
    if not tokens:
        return ""
    mode = joiner.strip().upper()
    if mode not in ("OR", "AND", "NEAR"):
        mode = "OR"
    escaped = [f'"{token}"' for token in tokens]
    return f" {mode} ".join(escaped)


BONSAI_BACKGROUND_MODEL_ID = "local/bonsai-2-27b-pq2"


class HybridContextMemoryEngine:
    """
    SQLite WAL + FTS5 기반 하이브리드 컨텍스트 & 메모리 엔진
    - 무임베딩 고속 전문 검색 (FTS5, 쿼리 살균으로 syntax error 원천 차단)
    - 주입된 요약기 또는 명시적으로 표시된 extractive 요약
    - 해시로 검증하는 상태 체크포인트 및 파일시스템 복원
    """
    def __init__(self, db_path: str = ":memory:"):
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        cur = self.conn.cursor()
        if self.db_path != ":memory:":
            cur.execute("PRAGMA journal_mode=WAL;")
        cur.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
                doc_id UNINDEXED,
                category,
                title,
                content
            );
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS checkpoints (
                checkpoint_id TEXT PRIMARY KEY,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                files_json TEXT NOT NULL,
                metadata_json TEXT DEFAULT '{}'
            );
        """)
        self.conn.commit()

    def index_document(self, category: str, title: str, content: str) -> str:
        doc_id = hashlib.sha256(f"{category}:{title}:{content}".encode("utf-8")).hexdigest()[:16]
        cur = self.conn.cursor()
        cur.execute(
            "INSERT INTO knowledge_fts (doc_id, category, title, content) VALUES (?, ?, ?, ?)",
            (doc_id, category, title, content)
        )
        self.conn.commit()
        return doc_id

    def search(
        self,
        query: str,
        limit: int = 5,
        category: Optional[str] = None,
        joiner: str = "OR",
    ) -> List[Dict[str, Any]]:
        """살균된 FTS5 질의로 문서를 검색한다.

        쿼리에 연산자나 구두점(`def foo():`, `x->y`, `JSON["k"]`)이 포함되어도
        FTS5 syntax error 없이 안전하게 검색된다. 유효 토큰이 없으면 빈 목록 반환.
        """
        match_expr = sanitize_fts5_query(query, joiner=joiner)
        if not match_expr:
            return []

        cur = self.conn.cursor()
        if category:
            sql = """
                SELECT doc_id, category, title, content, bm25(knowledge_fts) AS score
                FROM knowledge_fts
                WHERE knowledge_fts MATCH ? AND category = ?
                ORDER BY score
                LIMIT ?
            """
            params: tuple[Any, ...] = (match_expr, category, limit)
        else:
            sql = """
                SELECT doc_id, category, title, content, bm25(knowledge_fts) AS score
                FROM knowledge_fts
                WHERE knowledge_fts MATCH ?
                ORDER BY score
                LIMIT ?
            """
            params = (match_expr, limit)

        cur.execute(sql, params)
        return [dict(row) for row in cur.fetchall()]

    def create_checkpoint(
        self,
        checkpoint_id: str,
        file_snapshots: Dict[str, str],
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """체크포인트 메타데이터와 파일 상태(경로->본문)를 저장한다."""
        cur = self.conn.cursor()
        cur.execute(
            """
            INSERT OR REPLACE INTO checkpoints (checkpoint_id, files_json, metadata_json)
            VALUES (?, ?, ?)
            """,
            (
                checkpoint_id,
                json.dumps(file_snapshots, ensure_ascii=False),
                json.dumps(metadata or {}, ensure_ascii=False),
            ),
        )
        self.conn.commit()

    def snapshot_filesystem(
        self,
        checkpoint_id: str,
        file_paths: List[Union[str, Path]],
        base_dir: Union[str, Path] = ".",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, str]:
        """지정된 실제 파일들의 본문을 읽어 체크포인트로 저장한다."""
        snapshots: Dict[str, str] = {}
        hashes: Dict[str, str] = {}
        # Resolve all entries before any checkpoint mutation.
        targets = [(str(rel), resolve_within(base_dir, rel)) for rel in file_paths]
        for rel, target in targets:
            if target.is_file():
                payload = target.read_bytes()
                snapshots[rel] = payload.decode("utf-8")
                hashes[rel] = hash_bytes(payload)
        checked_metadata = dict(metadata or {})
        checked_metadata["filesystem_hashes"] = hashes
        self.create_checkpoint(checkpoint_id, snapshots, metadata=checked_metadata)
        return snapshots

    def restore_checkpoint(self, checkpoint_id: str) -> Dict[str, str]:
        """체크포인트에 저장된 파일 스냅샷 맵(`{path: content}`)을 반환한다."""
        cur = self.conn.cursor()
        cur.execute("SELECT files_json FROM checkpoints WHERE checkpoint_id = ?", (checkpoint_id,))
        row = cur.fetchone()
        if not row:
            raise KeyError(f"Checkpoint not found: {checkpoint_id}")
        return json.loads(row["files_json"])

    def restore_to_filesystem(
        self,
        checkpoint_id: str,
        base_dir: Union[str, Path] = ".",
        expected_hashes: Optional[Dict[str, str]] = None,
    ) -> List[str]:
        """Restore only against caller-approved current hashes (default: snapshot hashes).

        A changed file requires an explicit expected_hashes map; stale or corrupted
        checkpoints never overwrite current work. All paths/hashes pass before writing.
        """
        snapshots = self.restore_checkpoint(checkpoint_id)
        saved_hashes = self.get_checkpoint_metadata(checkpoint_id).get("filesystem_hashes", {})
        ops = []
        for rel, content in snapshots.items():
            resolve_within(base_dir, rel)
            if saved_hashes.get(rel) != hash_bytes(content.encode("utf-8")):
                raise HashMismatchError(f"checkpoint content hash mismatch: {rel}")
            expected = saved_hashes.get(rel) if expected_hashes is None else expected_hashes.get(rel)
            if expected is None:
                raise HashMismatchError(f"missing expected current hash for checkpoint file: {rel}")
            ops.append({"path": rel, "expected_pre_hash": expected, "new_content": content})
        return apply_edits(base_dir, ops)

    def get_checkpoint_metadata(self, checkpoint_id: str) -> Dict[str, Any]:
        cur = self.conn.cursor()
        cur.execute("SELECT metadata_json, created_at FROM checkpoints WHERE checkpoint_id = ?", (checkpoint_id,))
        row = cur.fetchone()
        if not row:
            raise KeyError(f"Checkpoint not found: {checkpoint_id}")
        meta = json.loads(row["metadata_json"])
        meta["created_at"] = row["created_at"]
        return meta

    def list_checkpoints(self) -> List[Dict[str, Any]]:
        cur = self.conn.cursor()
        cur.execute("SELECT checkpoint_id, created_at, metadata_json FROM checkpoints ORDER BY created_at DESC")
        items = []
        for row in cur.fetchall():
            items.append({
                "checkpoint_id": row["checkpoint_id"],
                "created_at": row["created_at"],
                "metadata": json.loads(row["metadata_json"]),
            })
        return items

    def distill_and_summarize(
        self,
        content: str,
        model_id: str = BONSAI_BACKGROUND_MODEL_ID,
        max_sentences: int = 3,
        summarizer: Optional[Callable[[str], str]] = None,
    ) -> str:
        """Use an injected summarizer, otherwise label keyword extraction as extractive."""
        text = (content or "").strip()
        if not text:
            return ""
        if summarizer is not None:
            result = summarizer(text)
            if not isinstance(result, str):
                raise TypeError("injected summarizer must return text")
            return result

        # 문장 단위 분할 (줄바꿈 및 마침표 기준)
        raw_sentences = [
            s.strip()
            for s in re.split(r"(?<=[.!?\n])\s+", text)
            if len(s.strip()) > 3
        ]
        if not raw_sentences:
            return "[Extractive summary]\n" + text

        # 우선순위 키워드(결정, 오류, 계약, 인터페이스, 사실) 매칭 문장 우선 채택
        priority_keywords = (
            "결정", "원인", "오류", "해결", "수정", "인터페이스", "규칙",
            "decision", "root cause", "error", "fix", "contract", "rule", "goal",
        )
        scored: List[tuple[int, int, str]] = []
        for idx, sentence in enumerate(raw_sentences):
            low = sentence.lower()
            weight = sum(2 for kw in priority_keywords if kw in low)
            # 첫 문장 및 마지막 문장에는 구조적 가중치 부여
            if idx == 0:
                weight += 1
            scored.append((weight, -idx, sentence))

        scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
        top_sentences = [item[2] for item in scored[:max_sentences]]
        distilled_body = "\n".join(f"- {s}" for s in top_sentences)

        return (
            "[Extractive summary]\n"
            f"{distilled_body}"
        )

    def index_distilled_document(
        self,
        category: str,
        title: str,
        content: str,
        model_id: str = BONSAI_BACKGROUND_MODEL_ID,
    ) -> str:
        """컨텐츠를 Bonsai-2 27B 훅으로 증류한 뒤 FTS5 테이블에 인덱싱한다."""
        distilled = self.distill_and_summarize(content, model_id=model_id)
        combined = f"{distilled}\n\n[Original Content]\n{content.strip()}"
        return self.index_document(category=category, title=title, content=combined)

    def close(self) -> None:
        self.conn.close()
