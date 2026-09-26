# apron-hammer

A load generator for an Apron server. Each scenario drives many concurrent
WebSocket clients with ordinary protocol traffic, then reports throughput,
latency percentiles, errors, and server disconnects. Against `aprond` started
with `-debug-addr`, it also samples the server's heap and goroutines every
second and compares what the server retains before and after each scenario.

```sh
# Terminal 1: the server, with pprof and expvar on a separate listener.
go run ./cmd/aprond --debug-addr 127.0.0.1:6060

# Terminal 2: every scenario, 50 clients, 10 seconds each.
go run ./cmd/apron-hammer -profile-dir /tmp/apron-profiles
```

Scenarios run in order against the same server, so the state earlier ones
leave behind (messages, threads, uploads) is part of the load for later ones.
Restart the server between runs you want to compare.

| Scenario   | Load |
|------------|------|
| `churn`    | connect, sign in as a guest, and disconnect as fast as possible; each guest's join to `general` at sign-in and its leave on disconnect are logged memberships |
| `flood`    | every client posts to `general` with one request in flight; checks each connection sees each room's log_ids (messages, reactions, memberships) in order |
| `activity` | every client sends typing activity to `general` |
| `slow`     | half the clients stop reading while the rest post 4 KiB messages; the server should drop the stalled ones |
| `history`  | seed a room with 20,000 messages, then page it with `limit` 100 and 1000 |
| `threads`  | create 1,000 threads with `room_set`, then concurrently `room_list` them (`filter: "not_joined"`) and the joined rooms with `members: true`, or sign in with `room_list` (`filter: "joined"`, `members: true`) pipelined behind `auth`, then `room_join` and `room_leave` a thread |
| `edits`    | post, edit three times, react, clear, and delete, in a loop |
| `embeds`   | 64 KiB uploads read back from their file URLs, and two-second live streams read while they are written |

Flags:

- `-server 127.0.0.1:8080`, `-origin <origin>` (none by default)
- `-debug http://127.0.0.1:6060`: the `-debug-addr` listener; empty skips server monitoring
- `-scenarios churn,flood` or `all`; `-list` prints them
- `-clients 50`, `-duration 10s`, `-body-bytes 200` (flood message size)
- `-profile-dir <dir>`: saves `<scenario>.cpu.pprof` for the measured window,
  and `heap`, `allocs`, and `goroutine` profiles after it
  (`allocs-before` too, for `go tool pprof -base`)
- `-v`: print each server sample

Read a profile with, for example,
`go tool pprof -top -cum /tmp/apron-profiles/flood.cpu.pprof`.

The client and server share the machine's CPUs when run together, so a
client that falls behind its connection's outgoing queue is disconnected by
the server as a slow consumer. The report counts these as server disconnects.
