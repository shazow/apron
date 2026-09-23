// Apron Chat v3 for trusted, compliant clients. Requires Bun; no dependencies.
// Run: bun apron-server.js
// LAN: HOST=0.0.0.0 PORT=8765 bun apron-server.js
// One room, guest identities, names, replies, ext pass-through, and the latest
// 1,000 log records of RAM history. Restart clears history; reconnect assigns a
// new identity. No retry deduplication, edits, room changes, reactions, uploads,
// credentials, or rate limits. Clients must send valid protocol frames;
// malformed input may close the connection.

const greeting = { protocol: 3, name: "apron-bun/3", auth: ["guest"], caps: ["history"] };
const log = []; // Room and message records, ascending by log_id.
let lastLogId = 0;

function nextLogId() {
  lastLogId = Math.max(Date.now(), lastLogId + 1);
  return String(lastLogId);
}

function append(record) {
  log.push(record);
  if (log.length > 1000) log.shift();
  return record;
}

const room = append({ room_id: "general", log_id: nextLogId(), title: "General" });

function send(ws, frame) {
  ws.send(JSON.stringify(frame));
}

function check(condition, message, code = -32602) {
  if (!condition) throw { code, message };
}

function availability() {
  return { latest_log_id: String(lastLogId), history_log_id: log[0].log_id };
}

function readHistory(params) {
  const limit = Math.min(params.limit ?? 50, 200);
  check(Number.isInteger(limit) && limit > 0, "Invalid limit");
  check(["after", "before"].every(key => /^\d+$/.test(params[key] ?? "0")), "Invalid bounds");
  const after = Number(params.after ?? 0);
  const before = Number(params.before ?? lastLogId);
  const matches = log.filter(record => {
    const logId = Number(record.log_id);
    return logId >= after && logId <= before;
  });
  const slice = "after" in params ? matches.slice(0, limit) : matches.slice(-limit);
  const result = {
    rooms: slice.filter(record => !record.message_id),
    entries: slice.filter(record => record.message_id),
    more: matches.length > limit,
    ...availability(),
  };
  if (slice.length) {
    result.first_id = slice[0].log_id;
    result.last_id = slice.at(-1).log_id;
  }
  return result;
}

function createMessage(you, params) {
  check(params.body && typeof params.body === "object", "Missing body");
  check(!params.deleted, "Cannot create a deleted message");
  const replyTo = params.reply_to?.message_id;
  // The new ID is minted below, so a known target can never be the message itself.
  if ("reply_to" in params) {
    check(typeof replyTo === "string" && log.some(record => record.message_id === replyTo), "Unknown reply target");
  }

  const id = nextLogId();
  const message = {
    message_id: id, log_id: id, room_id: "general", from: { ...you },
    body: { format: "plain", ...params.body },
  };
  if ("reply_to" in params) message.reply_to = { message_id: replyTo };
  if (params.ext) message.ext = params.ext;
  append(message);
  // Server.publish includes the sender; ws.publish would exclude it.
  server.publish("general", JSON.stringify({ method: "message", params: message }));
  return { message_id: id };
}

// Keep this synchronous: history reads, commits, and broadcasts must stay ordered.
function dispatch(ws, method, params) {
  if (method === "auth") ws.data.you ??= { user_id: "guest_" + crypto.randomUUID() }; // Any scheme.
  check(ws.data.you, "Authenticate first", -32001);
  if (method === "auth" || method === "name") {
    if (typeof params.name === "string") ws.data.you = { ...ws.data.you, name: params.name };
    return { you: ws.data.you };
  }

  check(method === "message" || method === "history", "Unsupported method", -32601);
  check(method !== "message" || !("message_id" in params), "Editing is unsupported", -32601);
  check(params.room_id === "general", "Unknown room");
  return method === "history" ? readHistory(params) : createMessage(ws.data.you, params);
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
    closeOnBackpressureLimit: true, // Disconnect slow clients instead of dropping live records.
    open(ws) {
      send(ws, { method: "server", params: greeting });
    },
    message(ws, raw) {
      let frame;
      try {
        frame = JSON.parse(raw);
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) return ws.close(1003, "Invalid frame");
        const result = dispatch(ws, frame.method, frame.params ?? {});
        if ("id" in frame) send(ws, { id: frame.id, result });
        if (frame.method === "auth") {
          send(ws, { method: "room", params: { ...room, ...availability() } });
          ws.subscribe("general");
        }
      } catch (error) {
        if (!error.code) return ws.close(1003, "Invalid frame");
        if (frame?.id !== undefined) send(ws, { id: frame.id, error });
      }
    },
  },
});
console.log(`Apron Chat listening on ws://${server.hostname}:${server.port}`);
