# Session API boundaries

Approved conversational scope: Session owns the public model/thread APIs.
Controller owns lifecycle, plugins and Session creation/restoration/listing.
Remove Controller.models and Controller thread CRUD methods; no aliases.
Keep Agent standalone execution and Controller plugins without a Session.

## Model

- `session.model.get(): string`: full `providerId/modelId` identifier.
- `name(): string`: native modelId, which may itself contain slashes.
- `list()`: readonly data entries `{ id, name, profile }`, including selected model.
- `switch(modelId, options?)`: full ID from list, or a native ID on the current
  connection. Select the destination adapter's configured defaults plus this
  call's shallow overrides. Replace nested objects and previous Session overrides.
  No `set` or legacy `setModel` method.
- Preserve the current provider and connection for same-provider model changes.
  Registered provider IDs distinguish connections; no implicit endpoint changes.
- Snapshot identity/options when input is accepted. Running/queued executions
  retain that snapshot; switch affects subsequently accepted input. Resume/recover
  retain their stored execution selection.
- Keep existing before/after model hooks. Add previousOptions/options without
  changing existing identity payload fields. Persist before the after event;
  denial, invalid options or failed writes do not emit a changed event.
- Transport credentials/endpoints belong to registered connections, not options.

## Threads

`session.thread` owns create/get/getId/list/switch/rename/fork/delete/purge/history.
create accepts only optional title, messages and metadata. ID is generated;
scope is inherited. No instructions option. create selects the new Thread,
fork does not select. Neither starts a model request.
create/switch reject running or queued Session work; suspended work remains
recoverable. Listing keeps existing scope filtering; no DB ownership redesign.
Preserve existing storage transactions, checkpoint/fork rules and policy hooks.
Returned Thread handles expose state/history/record reads. Execution methods
remain internal and are excluded from published declarations.

## Deferred content-part metadata note

A single HumanMessage can contain visible mention text and another text part
containing SKILL.md. Future part-level metadata should let applications mark
only the injected part as hidden in UI while retaining/sending both parts.
Current metadata exists only on the whole message. Record this limitation;
do not implement a new part schema, visibility policy or provider behavior now.

## Validation

Test API removal, defaults/options, queue snapshots, events/denials/failed writes,
scope, persistence/restart and standalone Agent behavior. Build consumers against
published-style declarations as well as source types. Then run ponytail-audit
across the repository; report complexity findings without applying them.
