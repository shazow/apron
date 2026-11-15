// TLS terminator: node tlsproxy.cjs <listenPort> <targetPort> [rewriteHost]
// Without rewriteHost it pipes raw TCP (Host kept). With it, it proxies HTTP and rewrites Host (for vite).
const fs = require('node:fs'), tls = require('node:tls'), net = require('node:net'), https = require('node:https'), http = require('node:http');
const [listen, target, rewrite] = process.argv.slice(2);
const opts = { key: fs.readFileSync(__dirname + '/test.key'), cert: fs.readFileSync(__dirname + '/test.crt') };
if (!rewrite) {
  tls.createServer(opts, (s) => { const c = net.connect(+target, '127.0.0.1'); s.pipe(c).pipe(s); c.on('error', () => s.destroy()); s.on('error', () => c.destroy()); }).listen(+listen, '127.0.0.1');
} else {
  const server = https.createServer(opts, (req, res) => {
    const p = http.request({ host: '127.0.0.1', port: +target, path: req.url, method: req.method, headers: { ...req.headers, host: rewrite } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => res.destroy()); req.pipe(p);
  });
  server.on('upgrade', (req, sock, head) => {
    const c = net.connect(+target, '127.0.0.1', () => {
      c.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries({ ...req.headers, host: rewrite }).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n'); c.write(head); c.pipe(sock).pipe(c);
    }); c.on('error', () => sock.destroy()); sock.on('error', () => c.destroy());
  });
  server.listen(+listen, '127.0.0.1');
}
console.log('listening', listen, '->', target, rewrite || '(raw)');
