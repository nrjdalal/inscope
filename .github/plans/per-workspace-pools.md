# Idea: an account pool per workspace

Status: idea, to discuss. Not designed yet.

## The idea

Today `inscope proxy` has one pool, and every proxied workspace rotates across all of its accounts. Instead, each workspace (isolated or the shared login) would get its own pool. For example:

- the shared login keeps one personal account;
- the `work` workspace rotates between the two accounts the employer gave (`a@work`, `b@work`).

That way personal and work accounts never serve each other's conversations.

## Options to explore

- One proxy per pool, each with its own port and auth dir.
- One proxy that maps each client key to its own set of accounts. Check whether CLIProxyAPI supports this.
- With a built-in proxy (see `native-proxy.md`), routing per pool is straightforward.

## Decided

- The shared login goes through the proxy too (see `proxy-first.md`), so it gets a
  pool like any workspace; by default, all accounts.
