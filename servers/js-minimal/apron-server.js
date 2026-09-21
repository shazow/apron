// Apron Chat v2 for trusted, compliant clients. Requires Bun; no dependencies.
// Run: bun apron_server.js
// LAN: HOST=0.0.0.0 PORT=8765 bun apron_server.js
// One room, anonymous identities, replies, and 1,000 messages of RAM history.
// Restart clears history; reconnect assigns a new identity. No retry deduplication,
// edits, threads, uploads, credentials, or rate limits. Clients must send valid
// protocol frames; malformed input may close the connection.

const greeting = {
  protocol: 2, name: "apron-bun/1", auth: ["anonymous"], caps: ["history"],
};
const log = [];
let lastLogId = 0;

function send(ws, frame) {
  ws.send(JSON.stringify(frame));
}

function check(condition, message, code = -32602) {
  if (!condition) throw { code, message };
}

function historyBounds() {
  return {
    latest_log_id: String(lastLogId),
    history_log_id: log[0]?.log_id ?? null,
  };
}

function readHistory(params) {
  const limit = Math.min(params.limit ?? 50, 200);
  const after = Number(params.after ?? 0);
  const before = Number(params.before ?? lastLogId);
  const matches = log.filter(entry => {
    const logId = Number(entry.log_id);
    return logId >= after && logId <= before;
  });
  const entries = "after" in params ? matches.slice(0, limit) : matches.slice(-limit);
  const result = { entries, more: matches.length > limit, ...historyBounds() };
  if (entries.length) {
    result.first_id = entries[0].log_id;
    result.last_id = entries.at(-1).log_id;
  }
  return result;
}

// Keep this synchronous: history reads, commits, and broadcasts must stay ordered.
function dispatch(ws, method, params) {
  if (method === "auth") {
    check(params.scheme === "anonymous", "Use anonymous auth", -32001);
    ws.data.you ??= { user_id: "guest_" + crypto.randomUUID() };
  }
  check(ws.data.you, "Authenticate first", -32001);
  if (method === "auth" || method === "name") {
    if ("name" in params) {
      ws.data.you = { ...ws.data.you, name: params.name };
    }
    return { you: ws.data.you };
  }

  check(method === "message" || method === "history", "Unsupported method", -32601);
  if (method === "message") {
    check(!("message_id" in params), "Editing is unsupported", -32601);
  }
  check(params.room_id === "general", "Unknown room");
  check(!("thread_id" in params), "Unknown thread");
  if (method === "history") return readHistory(params);

  if ("reply_message_id" in params) {
    const targetExists = log.some(entry => entry.log_id === params.reply_message_id);
    check(targetExists, "Unknown reply target");
  }
  lastLogId = Math.max(Date.now(), lastLogId + 1);
  const messageId = String(lastLogId);
  const { room_id, from, log_id, ...fields } = params;
  const message = { ...fields, message_id: messageId, from: { ...ws.data.you } };
  const entry = { log_id: messageId, message };
  log.push(entry);
  if (log.length > 1000) log.shift();

  // Server.publish includes the sender; ws.publish would exclude it.
  const event = { method: "message", params: { room_id: "general", ...entry } };
  server.publish("general", JSON.stringify(event));
  return { message_id: messageId };
}

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8765),
  fetch(req, server) {
    if (server.upgrade(req, { data: {} })) return;
    return new Response("WebSocket required", { status: 426 });
  },
  websocket: {
    maxPayloadLength: 256 * 1024,
    closeOnBackpressureLimit: true, // Disconnect slow clients instead of dropping live entries.
    open(ws) {
      send(ws, { method: "server", params: greeting });
    },
    message(ws, raw) {
      let frame;
      try {
        frame = JSON.parse(raw);
        const result = dispatch(ws, frame.method, frame.params ?? {});
        if ("id" in frame) send(ws, { id: frame.id, result });
        if (frame.method === "auth") {
          const room = { room_id: "general", name: "General", ...historyBounds() };
          send(ws, { method: "room", params: room });
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
