# Changelog

## 0.1.0

### Features

- The orchestrator skill: every chat message is recorded as a trigger. A reply on a ticket's
  thread goes to that ticket's worker; anything else passes the gate and comes back as a
  candidate to accept, attach, stop or ignore.
- Policy: accept modes `off`, `observe` and `auto`, rules for proactive work, allowed senders,
  an admission table, a policy version, and effects of a change on live tickets.
- Tickets with an immutable mandate, revalidated before an ended ticket resumes. Assignments
  and turns, worker slots with one extra slot for the person, retry, status requests, notes,
  and recovery of turns cut off by a restart.
- Subscriptions with follow-up fan-out, handback, release of unread messages when a ticket
  ends, threads followed for context, and unsubscribe.
- Structured reports and attention questions; replies checked by purpose, at most 100 words
  and never sent twice.
- Five worker sub-agents (code, research, analysis, review, docs) on the model from your
  sub-agent list best suited to the type of task and its requirements. Limits fail over to
  the next model.
- Editable team sections: Communication, Ticket scope, Delivery requirements.
