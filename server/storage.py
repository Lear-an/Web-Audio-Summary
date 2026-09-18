from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

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
        self.lock = asyncio.Lock()

    async def initialize(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def ping(self) -> bool:
        return True

    async def create_session(self, value: dict[str, Any]) -> None:
        async with self.lock:
            self.sessions[(value["owner_id"], value["session_id"])] = deepcopy(value)

    async def get_session(self, owner_id: str, session_id: str) -> dict[str, Any] | None:
        async with self.lock:
            return public_document(self.sessions.get((owner_id, session_id)))

    async def update_session(self, owner_id: str, session_id: str, values: dict[str, Any]) -> None:
        async with self.lock:
            key = (owner_id, session_id)
            if key not in self.sessions:
                raise KeyError(session_id)
            self.sessions[key].update(deepcopy(values))
            self.sessions[key]["updated_at"] = utcnow()

    async def get_chunk(self, owner_id: str, session_id: str, sequence: int) -> dict[str, Any] | None:
        async with self.lock:
            return public_document(self.chunks.get((owner_id, session_id, sequence)))

    async def upsert_chunk(self, value: dict[str, Any]) -> None:
        async with self.lock:
            key = (value["owner_id"], value["session_id"], int(value["sequence"]))
            self.chunks[key] = deepcopy(value)

    async def list_chunks(self, owner_id: str, session_id: str) -> list[dict[str, Any]]:
        async with self.lock:
            values = [
                public_document(value)
                for key, value in self.chunks.items()
                if key[0] == owner_id and key[1] == session_id
            ]
        return sorted((value for value in values if value is not None), key=lambda value: value["sequence"])

    async def save_document(self, value: dict[str, Any]) -> dict[str, Any]:
        async with self.lock:
            key = (value["owner_id"], value["session_id"])
            existing = self.documents.get(key)
            if existing is not None:
                return public_document(existing) or {}
            self.documents[key] = deepcopy(value)
            return public_document(value) or {}

    async def get_document_for_session(self, owner_id: str, session_id: str) -> dict[str, Any] | None:
        async with self.lock:
            return public_document(self.documents.get((owner_id, session_id)))

    async def list_documents(self, owner_id: str, limit: int) -> list[dict[str, Any]]:
        async with self.lock:
            values = [public_document(value) for (owner, _), value in self.documents.items() if owner == owner_id]
        result = [value for value in values if value is not None]
        result.sort(key=lambda value: value.get("created_at") or utcnow(), reverse=True)
        return result[:limit]

    async def get_document(self, owner_id: str, document_id: str) -> dict[str, Any] | None:
        async with self.lock:
            for (owner, _), value in self.documents.items():
                if owner == owner_id and value.get("document_id") == document_id:
                    return public_document(value)
        return None

    async def delete_document(self, owner_id: str, document_id: str) -> bool:
        async with self.lock:
            for key, value in list(self.documents.items()):
                if key[0] == owner_id and value.get("document_id") == document_id:
                    del self.documents[key]
                    return True
        return False

    async def delete_drafts(self, owner_id: str, session_id: str) -> None:
        async with self.lock:
            self.sessions.pop((owner_id, session_id), None)
            for key in [key for key in self.chunks if key[0] == owner_id and key[1] == session_id]:
                self.chunks.pop(key, None)

    async def expire_drafts(self, owner_id: str, session_id: str, expire_at: datetime) -> None:
        async with self.lock:
            session = self.sessions.get((owner_id, session_id))
            if session is not None:
                session["expire_at"] = expire_at
            for key, value in self.chunks.items():
                if key[0] == owner_id and key[1] == session_id:
                    value["expire_at"] = expire_at

    async def activate_drafts(self, owner_id: str, session_id: str) -> None:
        async with self.lock:
            session = self.sessions.get((owner_id, session_id))
            if session is not None:
                session.pop("expire_at", None)
            for key, value in self.chunks.items():
                if key[0] == owner_id and key[1] == session_id:
                    value.pop("expire_at", None)

    async def clear(self) -> None:
        async with self.lock:
            self.sessions.clear()
            self.chunks.clear()
            self.documents.clear()


class MongoStore:
    kind = "mongodb"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client: Any = None
        self.sessions: Any = None
        self.chunks: Any = None
        self.documents: Any = None

    async def initialize(self) -> None:
        try:
            from pymongo import ASCENDING, DESCENDING, MongoClient
        except ImportError as exc:
            raise RuntimeError("pymongo 패키지가 설치되지 않았습니다.") from exc

        self.client = MongoClient(self.settings.mongodb_uri, serverSelectionTimeoutMS=5000)
        database = self.client[self.settings.mongodb_database]
        self.sessions = database[self.settings.mongodb_session_collection]
        self.chunks = database[self.settings.mongodb_chunk_collection]
        self.documents = database[self.settings.mongodb_document_collection]

        def configure() -> None:
            self.client.admin.command("ping")
            self.sessions.create_index([("owner_id", ASCENDING), ("session_id", ASCENDING)], unique=True)
            self.sessions.create_index("expire_at", expireAfterSeconds=0)
            self.chunks.create_index(
                [("owner_id", ASCENDING), ("session_id", ASCENDING), ("sequence", ASCENDING)],
                unique=True,
            )
            self.chunks.create_index("expire_at", expireAfterSeconds=0)
            self.documents.create_index("document_id", unique=True)
            self.documents.create_index([("owner_id", ASCENDING), ("session_id", ASCENDING)], unique=True)
            self.documents.create_index([("owner_id", ASCENDING), ("created_at", DESCENDING)])

        await asyncio.to_thread(configure)

    async def close(self) -> None:
        if self.client is not None:
            await asyncio.to_thread(self.client.close)

    async def ping(self) -> bool:
        if self.client is None:
            return False
        try:
            await asyncio.to_thread(self.client.admin.command, "ping")
            return True
        except Exception:
            return False

    async def create_session(self, value: dict[str, Any]) -> None:
        await asyncio.to_thread(self.sessions.insert_one, deepcopy(value))

    async def get_session(self, owner_id: str, session_id: str) -> dict[str, Any] | None:
        value = await asyncio.to_thread(self.sessions.find_one, {"owner_id": owner_id, "session_id": session_id})
        return public_document(value)

    async def update_session(self, owner_id: str, session_id: str, values: dict[str, Any]) -> None:
        payload = {**deepcopy(values), "updated_at": utcnow()}
        result = await asyncio.to_thread(
            self.sessions.update_one,
            {"owner_id": owner_id, "session_id": session_id},
            {"$set": payload},
        )
        if not result.matched_count:
            raise KeyError(session_id)

    async def get_chunk(self, owner_id: str, session_id: str, sequence: int) -> dict[str, Any] | None:
        value = await asyncio.to_thread(
            self.chunks.find_one,
            {"owner_id": owner_id, "session_id": session_id, "sequence": sequence},
        )
        return public_document(value)

    async def upsert_chunk(self, value: dict[str, Any]) -> None:
        await asyncio.to_thread(
            self.chunks.replace_one,
            {"owner_id": value["owner_id"], "session_id": value["session_id"], "sequence": value["sequence"]},
            deepcopy(value),
            upsert=True,
        )

    async def list_chunks(self, owner_id: str, session_id: str) -> list[dict[str, Any]]:
        def fetch() -> list[dict[str, Any]]:
            cursor = self.chunks.find({"owner_id": owner_id, "session_id": session_id}).sort("sequence", 1)
            return [public_document(value) or {} for value in cursor]

        return await asyncio.to_thread(fetch)

    async def save_document(self, value: dict[str, Any]) -> dict[str, Any]:
        def save() -> dict[str, Any]:
            existing = self.documents.find_one({"owner_id": value["owner_id"], "session_id": value["session_id"]})
            if existing:
                return public_document(existing) or {}
            self.documents.insert_one(deepcopy(value))
            return public_document(value) or {}

        return await asyncio.to_thread(save)

    async def get_document_for_session(self, owner_id: str, session_id: str) -> dict[str, Any] | None:
        value = await asyncio.to_thread(
            self.documents.find_one,
            {"owner_id": owner_id, "session_id": session_id},
        )
        return public_document(value)

    async def list_documents(self, owner_id: str, limit: int) -> list[dict[str, Any]]:
        def fetch() -> list[dict[str, Any]]:
            cursor = self.documents.find({"owner_id": owner_id}).sort("created_at", -1).limit(limit)
            return [public_document(value) or {} for value in cursor]

        return await asyncio.to_thread(fetch)

    async def get_document(self, owner_id: str, document_id: str) -> dict[str, Any] | None:
        value = await asyncio.to_thread(
            self.documents.find_one,
            {"owner_id": owner_id, "document_id": document_id},
        )
        return public_document(value)

    async def delete_document(self, owner_id: str, document_id: str) -> bool:
        result = await asyncio.to_thread(
            self.documents.delete_one,
            {"owner_id": owner_id, "document_id": document_id},
        )
        return bool(result.deleted_count)

    async def delete_drafts(self, owner_id: str, session_id: str) -> None:
        await asyncio.gather(
            asyncio.to_thread(self.sessions.delete_one, {"owner_id": owner_id, "session_id": session_id}),
            asyncio.to_thread(self.chunks.delete_many, {"owner_id": owner_id, "session_id": session_id}),
        )

    async def expire_drafts(self, owner_id: str, session_id: str, expire_at: datetime) -> None:
        query = {"owner_id": owner_id, "session_id": session_id}
        update = {"$set": {"expire_at": expire_at}}
        await asyncio.gather(
            asyncio.to_thread(self.sessions.update_one, query, update),
            asyncio.to_thread(self.chunks.update_many, query, update),
        )

    async def activate_drafts(self, owner_id: str, session_id: str) -> None:
        query = {"owner_id": owner_id, "session_id": session_id}
        update = {"$unset": {"expire_at": ""}}
        await asyncio.gather(
            asyncio.to_thread(self.sessions.update_one, query, update),
            asyncio.to_thread(self.chunks.update_many, query, update),
        )


def create_store(settings: Settings) -> InMemoryStore | MongoStore:
    if settings.mongodb_uri:
        return MongoStore(settings)
    return InMemoryStore()
