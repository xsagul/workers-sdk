---
"miniflare": patch
"wrangler": patch
---

Recover automatically when an auto-selected inspector port is taken during startup

Previously, starting concurrent `wrangler dev` processes without `--inspector-port` could race in `ConfigController` and pick the same default inspector port (`9229`), causing `ProxyController` to fail with `ERR_ADDRESS_IN_USE`.

Miniflare now includes all configured socket addresses (such as direct sockets) when diagnosing bind failures and avoids suggesting `--port` for direct or connect sockets. In Wrangler, `ProxyController` now retries once with an OS-assigned ephemeral inspector port when an auto-selected inspector port collides at bind time, while explicit `--inspector-port` / `dev.inspector_port` conflicts still fail loudly with the bound address.
