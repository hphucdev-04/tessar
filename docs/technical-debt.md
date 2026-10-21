# Technical debt

## TD-002 — Application client SDK

Status: deferred. Tessar currently runs on Node.js. Application backends forward
`state_changed` events over their own SSE or WebSocket transport; browser clients
render `event.payload.state`.

A future client SDK should provide typed snapshot subscriptions, initial state
loading, unsubscribe and reconnection handling. Keep transport code outside core
and reuse the server snapshot contract. This phase adds no browser package or
automatic server-to-client synchronization.
