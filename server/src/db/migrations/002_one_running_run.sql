-- At most one running run per conversation.
--
-- Pi's own lock does not help here. Each turn rebuilds a fresh AgentSession from
-- stored entries, so two concurrent turns on one conversation each read the same
-- snapshot: the second one runs without seeing the first one's message and both
-- append. Pi would refuse a second prompt on a *live* session, but no session
-- lives between turns.
--
-- Measured before this index existed: two simultaneous turns both reported "ok",
-- appended 5 entries each, and the second model call never received the first
-- user message.
--
-- A partial unique index puts the guarantee in the database, where it holds for
-- any number of server instances, instead of in a process-local mutex that only
-- covers one. A crashed run is swept by failInterruptedRuns(), which frees the
-- conversation again.
CREATE UNIQUE INDEX agent_runs_one_running
  ON agent_runs (conversation_id)
  WHERE status = 'running';
