// Apron Chat v2 for trusted, compliant clients. Requires Bun; no dependencies.
// Run: bun apron_server.js
// LAN: HOST=0.0.0.0 PORT=8765 bun apron_server.js
// One room, anonymous identities, replies, and 1,000 messages of RAM history.
// Restart clears history; reconnect assigns a new identity. No retry deduplication,
// edits, threads, uploads, credentials, or rate limits. Clients must send valid
// protocol frames; malformed input may close the connection.

const greeting = { protocol: 2, name: "apron-bun/1", auth: ["anonymous"], caps: ["history"] };
const log = [];
let lastId = 0;
const send = (ws, frame) => ws.send(JSON.stringify(frame));
const boundaries = () => ({
  latest_log_id: String(lastId), history_log_id: log[0]?.log_id ?? null,
});
function require(condition, message, code = -32602) {
  if (!condition) throw { code, message };
}

// No awaits: history snapshots, commits, and broadcasts share one event-loop turn.
function dispatch(ws, method, p) {
  if (method === "auth") {
    require(p.scheme === "anonymous", "Use anonymous auth", -32001);
    ws.data.you ??= { user_id: "guest_" + crypto.randomUUID() };
  }
  require(ws.data.you, "Authenticate first", -32001);
  if (method === "auth" || method === "name") {
    if ("name" in p) ws.data.you = { ...ws.data.you, name: p.name };
    return { you: ws.data.you };
  }
  require(method === "message" || method === "history", "Unsupported method", -32601);
  if (method === "message") require(!("message_id" in p), "Editing is unsupported", -32601);
  require(p.room_id === "general", "Unknown room");
  require(!("thread_id" in p), "Unknown thread");

  if (method === "history") {
    const limit = Math.min(p.limit ?? 50, 200);
    const matches = log.filter(e => +e.log_id >= +(p.after ?? 0) && +e.log_id <= +(p.before ?? lastId));
    const entries = "after" in p ? matches.slice(0, limit) : matches.slice(-limit);
    return {
      entries, more: matches.length > limit, ...boundaries(),
      ...(entries.length && { first_id: entries[0].log_id, last_id: entries.at(-1).log_id }),
    };
  }

  if ("reply_message_id" in p) {
    require(log.some(e => e.log_id === p.reply_message_id), "Unknown reply target");
  }
  const message_id = String(lastId = Math.max(Date.now(), lastId + 1));
  const { room_id, from, log_id, ...fields } = p;
  const entry = { log_id: message_id, message: { ...fields, message_id, from: { ...ws.data.you } } };
  log.push(entry);
  if (log.length > 1000) log.shift();
  // Server.publish includes the sender; ws.publish would exclude it.
  server.publish("general", JSON.stringify({ method: "message", params: { room_id: "general", ...entry } }));
  return { message_id };
}

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8765),
  fetch(req, server) {
    if (!server.upgrade(req, { data: {} })) return new Response("WebSocket required", { status: 426 });
  },
  websocket: {
    maxPayloadLength: 256 * 1024,
    closeOnBackpressureLimit: true, // Disconnect slow clients instead of dropping live entries.
    open(ws) { send(ws, { method: "server", params: greeting }); },
    message(ws, raw) {
      let frame;
      try {
        frame = JSON.parse(raw);
        const result = dispatch(ws, frame.method, frame.params ?? {});
        if ("id" in frame) send(ws, { id: frame.id, result });
        if (frame.method === "auth") {
          send(ws, { method: "room", params: { room_id: "general", name: "General", ...boundaries() } });
          ws.subscribe("general");
        }
      } catch (error) {
        if (!error.code) return ws.close(1003, "Invalid frame");
        if ("id" in frame) send(ws, { id: frame.id, error });
      }
    },
  },
});
console.log(`Apron Chat listening on ws://${server.hostname}:${server.port}`);
