from __future__ import annotations

import asyncio
import os
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from dotenv import load_dotenv


load_dotenv(Path(__file__).with_name(".env.test.local"))
os.environ.setdefault("MOCK_OPENAI", "true")

from server.settings import Settings  # noqa: E402
from server.storage import MongoStore, utcnow  # noqa: E402


@pytest.mark.skipif(not os.getenv("MONGODB_TEST_URI"), reason="MONGODB_TEST_URI is not configured")
def test_resume_and_discard_transactions_on_isolated_database() -> None:
    async def verify() -> None:
        database = f"cv_{uuid.uuid4().hex[:20]}"
        store = MongoStore(Settings(mock_openai=True, mongodb_uri=os.environ["MONGODB_TEST_URI"], mongodb_database=database))
        initialized = False
        try:
            await store.initialize()
            initialized = True
            now = utcnow()
            expiry = now + timedelta(hours=1)
            await store.create_session({"owner_id": "validation", "session_id": "resumable", "document_id": "validation-doc", "status": "incomplete", "next_sequence": 1, "expire_at": expiry, "updated_at": now})
            await store.upsert_chunk({"owner_id": "validation", "session_id": "resumable", "sequence": 0, "status": "ready", "expire_at": expiry})
            await store.upsert_document({"owner_id": "validation", "session_id": "resumable", "document_id": "validation-doc", "status": "incomplete", "resume_status": "available"})

            outcome, draft, chunks = await store.resume_drafts("validation", "resumable", now, now + timedelta(minutes=3), 5)
            assert outcome == "ready"
            assert "expire_at" not in draft
            assert len(chunks) == 1 and "expire_at" not in chunks[0]
            assert "expire_at" not in await store.get_chunk("validation", "resumable", 0)
            assert store.service_state.find_one({"_id": "active-user:validation"}) is not None

            await store.delete_drafts_and_expire_document("validation", "resumable")
            assert await store.get_session("validation", "resumable") is None
            assert await store.get_chunk("validation", "resumable", 0) is None
            document = await store.get_document_for_session("validation", "resumable")
            assert document and document["resume_status"] == "expired"

            await store.create_session({"owner_id": "validation", "session_id": "missing-chunk", "document_id": "validation-missing", "status": "incomplete", "next_sequence": 1, "expire_at": expiry, "updated_at": now})
            outcome, _, _ = await store.resume_drafts("validation", "missing-chunk", now, now + timedelta(minutes=3), 5)
            assert outcome == "incomplete"
            assert "expire_at" in await store.get_session("validation", "missing-chunk")
        finally:
            if initialized:
                await asyncio.to_thread(store.client.drop_database, database)
            await store.close()

    asyncio.run(verify())
