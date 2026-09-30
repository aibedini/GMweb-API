# Data model

No schema migration. linked_sessions, linked_session_presence and pairing challenge/session rows are deleted for the authenticated self identity using existing revokeDevice transaction. Durable commands retain source_client_id, target_agent_id, timestamps, type and executor result. Activity JSONL carries content-free read request/status references, under existing 10,000-entry retention; durable command identity survives that log rotation.

Browser state: contact phone keys normalize equivalent Iranian national/international forms; volatile names overlay projected rows. Viewed and phone-confirmed watermarks are separate per-conversation sequence maps. They never cover a later sequence. Ready thread identity prevents a prior thread's READY state from authorizing a read on a just-selected thread. Browser visibility and Inbox tab selection gate read submission.
