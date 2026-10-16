"""RAG แบบเบาๆ สำหรับภาษาไทย — ไม่ต้องใช้ vector DB / embedding API / ตัดคำ

ภาษาไทยไม่มีช่องว่างคั่นคำ การตัดคำต้องใช้ไลบรารีหนักอย่าง pythainlp
ที่นี่จึงใช้ character n-gram (2-3 ตัวอักษร) + TF-IDF + cosine similarity แทน
ซึ่งทนต่อการสะกดต่างกันเล็กน้อย เช่น "ค่าส่ง" กับ "ค่าจัดส่ง" ก็ยังจับคู่กันได้

ขั้นตอน:
1) Load   : อ่านทุกไฟล์ .md ใน data/knowledge
2) Chunk  : ตัดเป็นชิ้นตามหัวข้อ "## " (1 หัวข้อ = 1 chunk)
3) Index  : แปลงแต่ละ chunk เป็นเวกเตอร์ TF-IDF ของ n-gram
4) Search : แปลงคำถามเป็นเวกเตอร์แบบเดียวกัน แล้วเอา chunk ที่ cosine สูงสุด top-k

ดัชนีจะถูกสร้างใหม่อัตโนมัติเมื่อไฟล์ในคลังความรู้ถูกแก้ (เช็คจาก mtime)
จึงแก้ไฟล์ .md แล้วเห็นผลทันทีโดยไม่ต้อง restart เซิร์ฟเวอร์
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

NGRAM_SIZES = (2, 3)
_STRIP_RE = re.compile(r"[\s\W_]+", re.UNICODE)

# คำลงท้าย/คำถามที่เจอแทบทุกประโยค ถ้าไม่ตัดทิ้ง n-gram ของคำพวกนี้จะทำให้
# "ส่งนานไหม" ไปตรงกับหัวข้อ "ฮาลาลไหม" แทนที่จะตรงกับเรื่องเวลาจัดส่ง
THAI_STOP_PHRASES = sorted(
    [
        "ได้ไหม", "ได้มั้ย", "ได้หรือเปล่า", "ได้หรือไม่", "หรือเปล่า", "หรือไม่",
        "ไหม", "มั้ย", "อะไรบ้าง", "อะไร", "ยังไง", "อย่างไร", "บ้าง",
        "ครับ", "ค่ะ", "คะ", "นะคะ", "นะครับ", "จ้า", "หน่อย", "เท่าไหร่", "เท่าไร",
        "กี่", "คือ", "ของร้าน", "ร้านนี้",
    ],
    key=len,
    reverse=True,
)


@dataclass
class Chunk:
    source: str   # ชื่อไฟล์
    title: str    # หัวข้อเอกสาร (# ...)
    heading: str  # หัวข้อย่อย (## ...)
    text: str

    @property
    def ref(self) -> str:
        return f"{self.source} › {self.heading}" if self.heading else self.source

    @property
    def body(self) -> str:
        return "\n".join(l for l in self.text.splitlines() if not l.startswith("\x00")).strip()

    def as_context(self) -> str:
        head = f"{self.title} / {self.heading}" if self.heading else self.title
        return f"### {head}\n{self.body}"


def _normalize(text: str) -> str:
    # ตัดช่องว่างและเครื่องหมายทิ้งหมด ภาษาไทยไม่ได้ใช้ช่องว่างแบ่งคำอยู่แล้ว
    s = _STRIP_RE.sub("", text.lower())
    for w in THAI_STOP_PHRASES:
        s = s.replace(w, "")
    return s


def _ngrams(text: str) -> Counter:
    s = _normalize(text)
    grams: Counter = Counter()
    for n in NGRAM_SIZES:
        for i in range(len(s) - n + 1):
            grams[s[i : i + n]] += 1
    return grams


def _chunk_markdown(path: Path) -> list[Chunk]:
    title = path.stem
    chunks: list[Chunk] = []
    heading, buf = "", []

    def flush():
        body = "\n".join(buf).strip()
        if body:
            chunks.append(Chunk(path.name, title, heading, body))

    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("# "):
            title = line[2:].strip()
        elif line.startswith("## "):
            flush()
            heading, buf = line[3:].strip(), []
        elif line.lower().startswith("คำค้น:"):
            # บรรทัด "คำค้น:" ใช้ช่วยให้ค้นเจอ แต่ไม่ส่งให้โมเดล
            buf.append("\x00" + line.split(":", 1)[1])
        else:
            buf.append(line)
    flush()
    return chunks


class KnowledgeBase:
    def __init__(self, folder: Path, extra_chunks=None, watch: list[Path] | None = None):
        self.folder = folder
        # watch: ไฟล์อื่นที่ถ้าแก้แล้วต้อง rebuild index ด้วย (เช่น shop.json)
        self.watch = watch or []
        # extra_chunks: ฟังก์ชันที่คืน list[Chunk] เพิ่ม (เช่น สร้างจาก shop.json)
        self.extra_chunks = extra_chunks
        self._signature: tuple | None = None
        self.chunks: list[Chunk] = []
        self._vectors: list[dict[str, float]] = []
        self._norms: list[float] = []
        self._idf: dict[str, float] = {}

    # ---------- index ----------
    def _current_signature(self) -> tuple:
        files = sorted(self.folder.glob("*.md")) + [w for w in self.watch if w.exists()]
        return tuple((f.name, f.stat().st_mtime_ns) for f in files)

    def _ensure_index(self) -> None:
        sig = self._current_signature()
        if sig == self._signature:
            return
        chunks: list[Chunk] = []
        for f in sorted(self.folder.glob("*.md")):
            chunks.extend(_chunk_markdown(f))
        if self.extra_chunks:
            chunks.extend(self.extra_chunks())

        # ใส่หัวข้อเข้าไปในข้อความที่ใช้ index ด้วย คำถามมักใช้คำเดียวกับหัวข้อ
        counts = [_ngrams(f"{c.title} {c.heading} {c.heading} {c.text}") for c in chunks]
        df: Counter = Counter()
        for cnt in counts:
            df.update(cnt.keys())
        n_docs = max(len(chunks), 1)
        self._idf = {g: math.log((1 + n_docs) / (1 + d)) + 1 for g, d in df.items()}

        self._vectors, self._norms = [], []
        for cnt in counts:
            vec = {g: (1 + math.log(tf)) * self._idf[g] for g, tf in cnt.items()}
            self._vectors.append(vec)
            self._norms.append(math.sqrt(sum(v * v for v in vec.values())) or 1.0)

        self.chunks = chunks
        self._signature = sig

    def reload(self) -> None:
        self._signature = None
        self._ensure_index()

    # ---------- search ----------
    def search(self, query: str, top_k: int = 3, min_score: float = 0.08) -> list[tuple[Chunk, float]]:
        self._ensure_index()
        q_cnt = _ngrams(query)
        q_vec = {g: (1 + math.log(tf)) * self._idf[g] for g, tf in q_cnt.items() if g in self._idf}
        if not q_vec:
            return []
        q_norm = math.sqrt(sum(v * v for v in q_vec.values()))

        scored = []
        for chunk, vec, norm in zip(self.chunks, self._vectors, self._norms):
            dot = sum(w * vec.get(g, 0.0) for g, w in q_vec.items())
            score = dot / (q_norm * norm)
            if score >= min_score:
                scored.append((chunk, round(score, 4)))
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:top_k]
