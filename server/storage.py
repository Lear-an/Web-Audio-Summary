from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any, Callable

from .settings import Settings


def utcnow() -> datetime:
    return datetime.now(UTC)


def public_document(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    result = deepcopy(value)
    result.pop("_id", None)
    return result


class InMemoryStore:
    kind = "memory"

    def __init__(self) -> None:
        self.sessions: dict[tuple[str, str], dict[str, Any]] = {}
        self.chunks: dict[tuple[str, str, int], dict[str, Any]] = {}
        self.documents: dict[tuple[str, str], dict[str, Any]] = {}
        self.service_state: dict[str, dict[str, Any]] = {}
        self.daily_usage: dict[tuple[str, str], dict[str, Any]] = {}
        self.lock = asyncio.Lock()

    async def initialize(self) -> None: pass
    async def close(self) -> None: pass
    async def ping(self) -> bool: return True

    async def scrub_source_urls(self, metadata: Callable[[str], dict[str, str]]) -> None:
        async with self.lock:
            for draft in self.sessions.values():
                source = metadata(draft.get("source_url") or draft.get("canonical_url") or "")
                draft.update({"source_url": source["canonical_url"], "canonical_url": source["canonical_url"], "source_url_hash": source["url_hash"], "source_host": source["host"], "source_video_id": source["video_id"]})
            for document in self.documents.values():
                original = document.get("source") or {}
                source = metadata(original.get("url") or original.get("canonical_url") or "")
                document["source"] = {**original, "url": source["canonical_url"], "canonical_url": source["canonical_url"], "url_hash": source["url_hash"], "host": source["host"], "video_id": source["video_id"]}

    async def create_session(self, value: dict[str, Any]) -> None:
        async with self.lock: self.sessions[(value["owner_id"], value["session_id"])] = deepcopy(value)

    async def get_session(self, owner_id: str, session_id: str) -> dict[str, Any] | None:
        async with self.lock: return public_document(self.sessions.get((owner_id, session_id)))

    async def update_session(self, owner_id: str, session_id: str, values: dict[str, Any]) -> None:
        async with self.lock:
            key = (owner_id, session_id)
            if key not in self.sessions: raise KeyError(session_id)
            self.sessions[key].update(deepcopy(values)); self.sessions[key]["updated_at"] = utcnow()

    async def get_chunk(self, owner_id: str, session_id: str, sequence: int) -> dict[str, Any] | None:
        async with self.lock: return public_document(self.chunks.get((owner_id, session_id, sequence)))

    async def claim_chunk(self, value: dict[str, Any], now: datetime) -> tuple[str, dict[str, Any]]:
        key = (value["owner_id"], value["session_id"], int(value["sequence"]))
        async with self.lock:
            old = self.chunks.get(key)
            if old and old.get("audio_sha256") != value["audio_sha256"]: return "conflict", public_document(old) or {}
            if old and old.get("status") == "ready": return "ready", public_document(old) or {}
            if old and old.get("status") == "processing" and old.get("lease_until", now) > now: return "busy", public_document(old) or {}
            row = {**(old or {}), **deepcopy(value), "status": "processing", "attempt_count": int((old or {}).get("attempt_count", 0)) + 1}
            self.chunks[key] = row
            return "claimed", public_document(row) or {}

    async def upsert_chunk(self, value: dict[str, Any]) -> None:
        async with self.lock:
            key = (value["owner_id"], value["session_id"], int(value["sequence"]))
            self.chunks[key] = {**self.chunks.get(key, {}), **deepcopy(value)}

    async def finish_chunk(self, claim: dict[str, Any], values: dict[str, Any]) -> bool:
        key = (claim["owner_id"], claim["session_id"], int(claim["sequence"]))
        async with self.lock:
            current = self.chunks.get(key)
            if not current or current.get("status") != "processing" or current.get("attempt_id") != claim["attempt_id"]:
                return False
            current.update(deepcopy(values))
            return True

    async def list_chunks(self, owner_id: str, session_id: str) -> list[dict[str, Any]]:
        async with self.lock: rows = [public_document(v) for k, v in self.chunks.items() if k[:2] == (owner_id, session_id)]
        return sorted((v for v in rows if v), key=lambda v: v["sequence"])

    async def upsert_document(self, value: dict[str, Any]) -> dict[str, Any]:
        async with self.lock:
            key = (value["owner_id"], value["session_id"])
            if self.documents.get(key, {}).get("status") == "completed" and value.get("status") != "completed":
                return public_document(self.documents[key]) or {}
            self.documents[key] = {**self.documents.get(key, {}), **deepcopy(value)}
            return public_document(self.documents[key]) or {}

    async def get_document_for_session(self, owner_id: str, session_id: str) -> dict[str, Any] | None:
        async with self.lock: return public_document(self.documents.get((owner_id, session_id)))

    async def list_documents(self, owner_id: str, limit: int) -> list[dict[str, Any]]:
        async with self.lock: rows = [public_document(v) for (o, _), v in self.documents.items() if o == owner_id]
        return sorted((v for v in rows if v), key=lambda v: v.get("requested_at") or v.get("created_at") or utcnow(), reverse=True)[:limit]

    async def get_document(self, owner_id: str, document_id: str) -> dict[str, Any] | None:
        async with self.lock: return next((public_document(v) for (o, _), v in self.documents.items() if o == owner_id and v.get("document_id") == document_id), None)

    async def delete_document(self, owner_id: str, document_id: str) -> str | None:
        async with self.lock:
            for key, value in list(self.documents.items()):
                if key[0] == owner_id and value.get("document_id") == document_id:
                    del self.documents[key]; return str(value["session_id"])
        return None

    async def delete_drafts(self, owner_id: str, session_id: str) -> None:
        async with self.lock:
            self.sessions.pop((owner_id, session_id), None)
            for key in [k for k in self.chunks if k[:2] == (owner_id, session_id)]: self.chunks.pop(key, None)

    async def delete_drafts_and_expire_document(self, owner_id: str, session_id: str) -> None:
        async with self.lock:
            self.sessions.pop((owner_id, session_id), None)
            for key in [k for k in self.chunks if k[:2] == (owner_id, session_id)]: self.chunks.pop(key, None)
            document = self.documents.get((owner_id, session_id))
            if document and document.get("status") != "completed":
                document.update({"resume_status": "expired", "resume_available_until": None, "updated_at": utcnow()})

    async def expire_drafts(self, owner_id: str, session_id: str, expire_at: datetime) -> None:
        async with self.lock:
            if (owner_id, session_id) in self.sessions: self.sessions[(owner_id, session_id)]["expire_at"] = expire_at
            for key, value in self.chunks.items():
                if key[:2] == (owner_id, session_id): value["expire_at"] = expire_at

    async def resume_drafts(self, owner_id: str, session_id: str, now: datetime, lease_until: datetime, maximum: int) -> tuple[str, dict[str, Any], list[dict[str, Any]]]:
        async with self.lock:
            key = (owner_id, session_id)
            draft = self.sessions.get(key)
            if not draft: return "missing", {}, []
            if draft.get("status") == "completed": return "completed", {}, []
            if draft.get("expire_at") and draft["expire_at"] <= now: return "expired", {}, []
            active = [v for v in self.service_state.values() if v.get("type") == "active_user" and v.get("lease_until", now) > now and v.get("owner_id") != owner_id]
            if len(active) >= maximum: return "limit", {}, []
            chunks = sorted((v for k, v in self.chunks.items() if k[:2] == key), key=lambda v: v["sequence"])
            ready = {int(v["sequence"]) for v in chunks if v.get("status") == "ready"}
            if not set(range(int(draft.get("next_sequence", 0)))).issubset(ready): return "incomplete", {}, []
            self.service_state[f"active-user:{owner_id}"] = {"type": "active_user", "owner_id": owner_id, "lease_until": lease_until}
            draft.pop("expire_at", None)
            draft["updated_at"] = now
            for chunk in chunks: chunk.pop("expire_at", None)
            return "ready", public_document(draft) or {}, [public_document(v) or {} for v in chunks]

    async def expire_stale_sessions(self, cutoff: datetime, expire_at: datetime) -> list[dict[str, Any]]:
        stale: list[dict[str, Any]] = []
        async with self.lock:
            for (owner_id, session_id), row in self.sessions.items():
                if row.get("status") == "incomplete" and row.get("partial_sync_pending"):
                    stale.append(public_document(row) or {})
                    continue
                if row.get("status") not in {"recording", "processing", "finalize_pending"} or row.get("expire_at") or row.get("updated_at", utcnow()) > cutoff:
                    continue
                row.update({"status": "incomplete", "idle_expired": True, "partial_sync_pending": True, "expire_at": expire_at, "updated_at": utcnow()})
                for key, chunk in self.chunks.items():
                    if key[:2] == (owner_id, session_id): chunk["expire_at"] = expire_at
                stale.append(public_document(row) or {})
        return stale

    async def acquire_user_lease(self, owner_id: str, lease_until: datetime, maximum: int, now: datetime) -> bool:
        async with self.lock:
            active = [v for v in self.service_state.values() if v.get("type") == "active_user" and v.get("lease_until", now) > now and v.get("owner_id") != owner_id]
            if len(active) >= maximum: return False
            self.service_state[f"active-user:{owner_id}"] = {"type": "active_user", "owner_id": owner_id, "lease_until": lease_until}
            return True

    async def release_user_lease(self, owner_id: str) -> None:
        async with self.lock: self.service_state.pop(f"active-user:{owner_id}", None)

    async def claim_finalize(self, owner_id: str, session_id: str, attempt_id: str, lease_until: datetime, now: datetime) -> bool:
        key = f"finalize:{owner_id}:{session_id}"
        async with self.lock:
            current = self.service_state.get(key)
            if current and current.get("lease_until", now) > now: return False
            self.service_state[key] = {"type": "finalize", "attempt_id": attempt_id, "lease_until": lease_until}; return True

    async def release_finalize(self, owner_id: str, session_id: str) -> None:
        async with self.lock: self.service_state.pop(f"finalize:{owner_id}:{session_id}", None)

    async def record_usage(self, owner_id: str, day: str, values: dict[str, int]) -> None:
        async with self.lock:
            row = self.daily_usage.setdefault((owner_id, day), {"owner_id": owner_id, "day": day})
            for name, amount in values.items(): row[name] = int(row.get(name, 0)) + int(amount)

    async def get_daily_audio_ms(self, owner_id: str, day: str) -> tuple[int, int]:
        async with self.lock:
            own = int(self.daily_usage.get((owner_id, day), {}).get("audio_ms", 0))
            total = sum(int(v.get("audio_ms", 0)) for (__, row_day), v in self.daily_usage.items() if row_day == day)
            return own, total

    async def record_provider_state(self, code: str, retry_after_seconds: int | None) -> None:
        async with self.lock:
            self.service_state["openai"] = {"type": "provider", "code": code, "retry_after_seconds": retry_after_seconds, "updated_at": utcnow()}

    async def reconcile(self, now: datetime) -> None:
        async with self.lock:
            for row in self.chunks.values():
                if row.get("status") == "processing" and row.get("lease_until", now) <= now:
                    row.update({"status": "retry_wait", "last_error": "processing_lease_expired"}); row.pop("lease_until", None)
            for row in self.documents.values():
                if row.get("status") == "incomplete" and row.get("resume_available_until") and row["resume_available_until"] <= now:
                    row["resume_status"] = "expired"; row["updated_at"] = now
            for key, row in list(self.service_state.items()):
                if row.get("lease_until") is not None and row["lease_until"] <= now: self.service_state.pop(key, None)

    async def clear(self) -> None:
        async with self.lock: self.sessions.clear(); self.chunks.clear(); self.documents.clear(); self.service_state.clear(); self.daily_usage.clear()


class MongoStore(InMemoryStore):
    kind = "mongodb"

    def __init__(self, settings: Settings) -> None:
        super().__init__(); self.settings = settings; self.client: Any = None

    async def initialize(self) -> None:
        try:
            from pymongo import ASCENDING, DESCENDING, MongoClient
        except ImportError as exc: raise RuntimeError("pymongo 패키지가 설치되지 않았습니다.") from exc
        self.client = MongoClient(self.settings.mongodb_uri, serverSelectionTimeoutMS=5000, tz_aware=True)
        db = self.client[self.settings.mongodb_database]
        self.sessions = db[self.settings.mongodb_session_collection]; self.chunks = db[self.settings.mongodb_chunk_collection]
        self.documents = db[self.settings.mongodb_document_collection]; self.service_state = db[self.settings.mongodb_service_state_collection]
        self.daily_usage = db[self.settings.mongodb_daily_usage_collection]
        def configure() -> None:
            self.client.admin.command("ping")
            self.sessions.create_index([("owner_id", ASCENDING), ("session_id", ASCENDING)], unique=True); self.sessions.create_index("expire_at", expireAfterSeconds=0)
            self.chunks.create_index([("owner_id", ASCENDING), ("session_id", ASCENDING), ("sequence", ASCENDING)], unique=True); self.chunks.create_index("expire_at", expireAfterSeconds=0)
            self.documents.create_index("document_id", unique=True); self.documents.create_index([("owner_id", ASCENDING), ("session_id", ASCENDING)], unique=True)
            self.documents.create_index([("owner_id", ASCENDING), ("requested_at", DESCENDING)]); self.documents.create_index([("owner_id", ASCENDING), ("source.url_hash", ASCENDING)]); self.daily_usage.create_index([("owner_id", ASCENDING), ("day", ASCENDING)], unique=True)
        await asyncio.to_thread(configure)

    async def close(self) -> None:
        if self.client is not None: await asyncio.to_thread(self.client.close)
    async def ping(self) -> bool:
        try: await asyncio.to_thread(self.client.admin.command, "ping"); return True
        except Exception: return False
    async def scrub_source_urls(self, metadata: Callable[[str], dict[str, str]]) -> None:
        def scrub() -> None:
            for draft in self.sessions.find({}, {"source_url": 1, "canonical_url": 1}):
                source = metadata(draft.get("source_url") or draft.get("canonical_url") or "")
                if draft.get("source_url") != source["canonical_url"] or draft.get("canonical_url") != source["canonical_url"]:
                    self.sessions.update_one({"_id": draft["_id"]}, {"$set": {"source_url": source["canonical_url"], "canonical_url": source["canonical_url"], "source_url_hash": source["url_hash"], "source_host": source["host"], "source_video_id": source["video_id"]}})
            for document in self.documents.find({}, {"source": 1}):
                original = document.get("source") or {}
                source = metadata(original.get("url") or original.get("canonical_url") or "")
                if original.get("url") != source["canonical_url"] or original.get("canonical_url") != source["canonical_url"]:
                    self.documents.update_one({"_id": document["_id"]}, {"$set": {"source.url": source["canonical_url"], "source.canonical_url": source["canonical_url"], "source.url_hash": source["url_hash"], "source.host": source["host"], "source.video_id": source["video_id"]}})
        await asyncio.to_thread(scrub)
    async def create_session(self, value: dict[str, Any]) -> None: await asyncio.to_thread(self.sessions.insert_one, deepcopy(value))
    async def get_session(self, owner_id: str, session_id: str) -> dict[str, Any] | None: return public_document(await asyncio.to_thread(self.sessions.find_one, {"owner_id": owner_id, "session_id": session_id}))
    async def update_session(self, owner_id: str, session_id: str, values: dict[str, Any]) -> None:
        result = await asyncio.to_thread(self.sessions.update_one, {"owner_id": owner_id, "session_id": session_id}, {"$set": {**deepcopy(values), "updated_at": utcnow()}})
        if not result.matched_count: raise KeyError(session_id)
    async def get_chunk(self, owner_id: str, session_id: str, sequence: int) -> dict[str, Any] | None: return public_document(await asyncio.to_thread(self.chunks.find_one, {"owner_id": owner_id, "session_id": session_id, "sequence": sequence}))
    async def claim_chunk(self, value: dict[str, Any], now: datetime) -> tuple[str, dict[str, Any]]:
        from pymongo import ReturnDocument
        from pymongo.errors import DuplicateKeyError
        identity = {"owner_id": value["owner_id"], "session_id": value["session_id"], "sequence": value["sequence"]}
        old = public_document(await asyncio.to_thread(self.chunks.find_one, identity))
        if old and old.get("audio_sha256") != value["audio_sha256"]: return "conflict", old
        if old and old.get("status") == "ready": return "ready", old
        if old and old.get("status") == "processing" and old.get("lease_until", now) > now: return "busy", old
        if old:
            query = {**identity, "audio_sha256": value["audio_sha256"], "$or": [{"status": {"$in": ["received", "retry_wait", "blocked", "failed"]}}, {"status": "processing", "lease_until": {"$lte": now}}]}
            claimed = await asyncio.to_thread(self.chunks.find_one_and_update, query, {"$set": {**value, "status": "processing", "updated_at": now}, "$inc": {"attempt_count": 1}}, return_document=ReturnDocument.AFTER)
            return ("claimed", public_document(claimed) or {}) if claimed else ("busy", public_document(await asyncio.to_thread(self.chunks.find_one, identity)) or {})
        try:
            row = {**value, "status": "processing", "attempt_count": 1, "created_at": now, "updated_at": now}
            await asyncio.to_thread(self.chunks.insert_one, row)
            return "claimed", public_document(row) or {}
        except DuplicateKeyError:
            current = public_document(await asyncio.to_thread(self.chunks.find_one, identity)) or {}
            if current.get("audio_sha256") != value["audio_sha256"]: return "conflict", current
            if current.get("status") == "ready": return "ready", current
            return "busy", current
    async def upsert_chunk(self, value: dict[str, Any]) -> None:
        query = {"owner_id": value["owner_id"], "session_id": value["session_id"], "sequence": value["sequence"]}; await asyncio.to_thread(self.chunks.update_one, query, {"$set": deepcopy(value)}, upsert=True)
    async def finish_chunk(self, claim: dict[str, Any], values: dict[str, Any]) -> bool:
        query = {"owner_id": claim["owner_id"], "session_id": claim["session_id"], "sequence": claim["sequence"], "status": "processing", "attempt_id": claim["attempt_id"]}
        result = await asyncio.to_thread(self.chunks.update_one, query, {"$set": deepcopy(values)})
        return bool(result.matched_count)
    async def list_chunks(self, owner_id: str, session_id: str) -> list[dict[str, Any]]:
        return await asyncio.to_thread(lambda: [public_document(v) or {} for v in self.chunks.find({"owner_id": owner_id, "session_id": session_id}).sort("sequence", 1)])
    async def upsert_document(self, value: dict[str, Any]) -> dict[str, Any]:
        from pymongo.errors import DuplicateKeyError
        identity = {"owner_id": value["owner_id"], "session_id": value["session_id"]}
        def save() -> dict[str, Any]:
            current = self.documents.find_one(identity)
            if current and current.get("status") == "completed" and value.get("status") != "completed":
                return public_document(current) or {}
            if current:
                query = {**identity, "status": {"$ne": "completed"}} if value.get("status") != "completed" else identity
                self.documents.update_one(query, {"$set": deepcopy(value)})
            else:
                try:
                    self.documents.insert_one({**deepcopy(value), "created_at": value.get("created_at", utcnow())})
                except DuplicateKeyError:
                    if value.get("status") == "completed":
                        self.documents.update_one(identity, {"$set": deepcopy(value)})
                    else:
                        self.documents.update_one({**identity, "status": {"$ne": "completed"}}, {"$set": deepcopy(value)})
            return public_document(self.documents.find_one(identity)) or {}
        return await asyncio.to_thread(save)
    async def get_document_for_session(self, owner_id: str, session_id: str) -> dict[str, Any] | None: return public_document(await asyncio.to_thread(self.documents.find_one, {"owner_id": owner_id, "session_id": session_id}))
    async def list_documents(self, owner_id: str, limit: int) -> list[dict[str, Any]]: return await asyncio.to_thread(lambda: [public_document(v) or {} for v in self.documents.find({"owner_id": owner_id}).sort("requested_at", -1).limit(limit)])
    async def get_document(self, owner_id: str, document_id: str) -> dict[str, Any] | None: return public_document(await asyncio.to_thread(self.documents.find_one, {"owner_id": owner_id, "document_id": document_id}))
    async def delete_document(self, owner_id: str, document_id: str) -> str | None:
        row = public_document(await asyncio.to_thread(self.documents.find_one_and_delete, {"owner_id": owner_id, "document_id": document_id})); return str(row["session_id"]) if row else None
    async def delete_drafts(self, owner_id: str, session_id: str) -> None:
        query = {"owner_id": owner_id, "session_id": session_id}; await asyncio.gather(asyncio.to_thread(self.sessions.delete_one, query), asyncio.to_thread(self.chunks.delete_many, query))
    async def delete_drafts_and_expire_document(self, owner_id: str, session_id: str) -> None:
        def delete() -> None:
            identity = {"owner_id": owner_id, "session_id": session_id}
            with self.client.start_session() as mongo_session:
                def transaction(tx) -> None:
                    self.sessions.delete_one(identity, session=tx)
                    self.chunks.delete_many(identity, session=tx)
                    self.documents.update_one({**identity, "status": {"$ne": "completed"}}, {"$set": {"resume_status": "expired", "resume_available_until": None, "updated_at": utcnow()}}, session=tx)
                mongo_session.with_transaction(transaction)
        await asyncio.to_thread(delete)
    async def expire_drafts(self, owner_id: str, session_id: str, expire_at: datetime) -> None:
        query = {"owner_id": owner_id, "session_id": session_id}; update = {"$set": {"expire_at": expire_at}}; await asyncio.gather(asyncio.to_thread(self.sessions.update_one, query, update), asyncio.to_thread(self.chunks.update_many, query, update))
    async def resume_drafts(self, owner_id: str, session_id: str, now: datetime, lease_until: datetime, maximum: int) -> tuple[str, dict[str, Any], list[dict[str, Any]]]:
        from pymongo import ReturnDocument
        def resume() -> tuple[str, dict[str, Any], list[dict[str, Any]]]:
            identity = {"owner_id": owner_id, "session_id": session_id}
            with self.client.start_session() as mongo_session:
                def transaction(tx) -> tuple[str, dict[str, Any], list[dict[str, Any]]]:
                    draft = self.sessions.find_one(identity, session=tx)
                    if not draft: return "missing", {}, []
                    if draft.get("status") == "completed": return "completed", {}, []
                    if draft.get("expire_at") and draft["expire_at"] <= now: return "expired", {}, []
                    own = self.service_state.find_one({"_id": f"active-user:{owner_id}"}, session=tx)
                    count = self.service_state.count_documents({"type": "active_user", "lease_until": {"$gt": now}}, session=tx)
                    if not own and count >= maximum: return "limit", {}, []
                    chunks = list(self.chunks.find(identity, session=tx).sort("sequence", 1))
                    ready = {int(v["sequence"]) for v in chunks if v.get("status") == "ready"}
                    if not set(range(int(draft.get("next_sequence", 0)))).issubset(ready): return "incomplete", {}, []
                    query = {**identity, "status": {"$ne": "completed"}, "$or": [{"expire_at": {"$exists": False}}, {"expire_at": {"$gt": now}}]}
                    updated = self.sessions.find_one_and_update(query, {"$unset": {"expire_at": ""}, "$set": {"updated_at": now}}, return_document=ReturnDocument.AFTER, session=tx)
                    if not updated: return "expired", {}, []
                    self.chunks.update_many(identity, {"$unset": {"expire_at": ""}}, session=tx)
                    self.service_state.update_one({"_id": f"active-user:{owner_id}"}, {"$set": {"type": "active_user", "owner_id": owner_id, "lease_until": lease_until}}, upsert=True, session=tx)
                    for chunk in chunks: chunk.pop("expire_at", None)
                    return "ready", public_document(updated) or {}, [public_document(v) or {} for v in chunks]
                return mongo_session.with_transaction(transaction)
        return await asyncio.to_thread(resume)
    async def expire_stale_sessions(self, cutoff: datetime, expire_at: datetime) -> list[dict[str, Any]]:
        from pymongo import ReturnDocument
        query = {"status": {"$in": ["recording", "processing", "finalize_pending"]}, "updated_at": {"$lte": cutoff}, "expire_at": {"$exists": False}}
        pending = await asyncio.to_thread(lambda: [public_document(row) or {} for row in self.sessions.find({"status": "incomplete", "partial_sync_pending": True})])
        candidates = await asyncio.to_thread(lambda: list(self.sessions.find(query)))
        stale: list[dict[str, Any]] = pending
        for candidate in candidates:
            identity = {"owner_id": candidate["owner_id"], "session_id": candidate["session_id"]}
            claimed = await asyncio.to_thread(self.sessions.find_one_and_update, {**identity, **query}, {"$set": {"status": "incomplete", "idle_expired": True, "partial_sync_pending": True, "expire_at": expire_at, "updated_at": utcnow()}}, return_document=ReturnDocument.AFTER)
            if claimed is None:
                continue
            await asyncio.to_thread(self.chunks.update_many, identity, {"$set": {"expire_at": expire_at}})
            stale.append(public_document(claimed) or {})
        return stale
    async def acquire_user_lease(self, owner_id: str, lease_until: datetime, maximum: int, now: datetime) -> bool:
        def acquire() -> bool:
            self.service_state.delete_many({"type": "active_user", "lease_until": {"$lte": now}}); own = self.service_state.find_one({"_id": f"active-user:{owner_id}"}); count = self.service_state.count_documents({"type": "active_user", "lease_until": {"$gt": now}})
            if not own and count >= maximum: return False
            self.service_state.update_one({"_id": f"active-user:{owner_id}"}, {"$set": {"type": "active_user", "owner_id": owner_id, "lease_until": lease_until}}, upsert=True); return True
        return await asyncio.to_thread(acquire)
    async def release_user_lease(self, owner_id: str) -> None: await asyncio.to_thread(self.service_state.delete_one, {"_id": f"active-user:{owner_id}"})
    async def claim_finalize(self, owner_id: str, session_id: str, attempt_id: str, lease_until: datetime, now: datetime) -> bool:
        from pymongo import ReturnDocument
        from pymongo.errors import DuplicateKeyError
        key = f"finalize:{owner_id}:{session_id}"
        def claim() -> bool:
            old = self.service_state.find_one({"_id": key})
            if old:
                return self.service_state.find_one_and_update({"_id": key, "lease_until": {"$lte": now}}, {"$set": {"type": "finalize", "attempt_id": attempt_id, "lease_until": lease_until}}, return_document=ReturnDocument.AFTER) is not None
            try:
                self.service_state.insert_one({"_id": key, "type": "finalize", "attempt_id": attempt_id, "lease_until": lease_until}); return True
            except DuplicateKeyError: return False
        return await asyncio.to_thread(claim)
    async def release_finalize(self, owner_id: str, session_id: str) -> None: await asyncio.to_thread(self.service_state.delete_one, {"_id": f"finalize:{owner_id}:{session_id}"})
    async def record_usage(self, owner_id: str, day: str, values: dict[str, int]) -> None: await asyncio.to_thread(self.daily_usage.update_one, {"owner_id": owner_id, "day": day}, {"$inc": values}, upsert=True)
    async def get_daily_audio_ms(self, owner_id: str, day: str) -> tuple[int, int]:
        def fetch() -> tuple[int, int]:
            own = self.daily_usage.find_one({"owner_id": owner_id, "day": day}) or {}
            total = next(self.daily_usage.aggregate([{"$match": {"day": day}}, {"$group": {"_id": None, "value": {"$sum": "$audio_ms"}}}]), {"value": 0})
            return int(own.get("audio_ms", 0)), int(total.get("value", 0))
        return await asyncio.to_thread(fetch)
    async def record_provider_state(self, code: str, retry_after_seconds: int | None) -> None: await asyncio.to_thread(self.service_state.update_one, {"_id": "openai"}, {"$set": {"type": "provider", "code": code, "retry_after_seconds": retry_after_seconds, "updated_at": utcnow()}}, upsert=True)
    async def reconcile(self, now: datetime) -> None:
        await asyncio.gather(asyncio.to_thread(self.chunks.update_many, {"status": "processing", "lease_until": {"$lte": now}}, {"$set": {"status": "retry_wait", "last_error": "processing_lease_expired"}, "$unset": {"lease_until": ""}}), asyncio.to_thread(self.service_state.delete_many, {"lease_until": {"$lte": now}}))
        await asyncio.to_thread(self.documents.update_many, {"status": "incomplete", "resume_available_until": {"$lte": now}}, {"$set": {"resume_status": "expired", "updated_at": now}})
    async def clear(self) -> None: await asyncio.gather(asyncio.to_thread(self.sessions.delete_many, {}), asyncio.to_thread(self.chunks.delete_many, {}), asyncio.to_thread(self.documents.delete_many, {}), asyncio.to_thread(self.service_state.delete_many, {}), asyncio.to_thread(self.daily_usage.delete_many, {}))


def create_store(settings: Settings) -> InMemoryStore | MongoStore:
    return MongoStore(settings) if settings.mongodb_uri else InMemoryStore()
