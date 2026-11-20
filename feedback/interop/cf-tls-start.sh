#!/bin/sh
cd /home/user/apron-server-cloudflare
exec npx wrangler dev --port 8444 --local-protocol https --https-key-path /tmp/claude-0/-home-user/20bcd46f-cefb-56b4-8905-7ffb49d5fe85/scratchpad/interop/test.key --https-cert-path /tmp/claude-0/-home-user/20bcd46f-cefb-56b4-8905-7ffb49d5fe85/scratchpad/interop/test.crt --ip 127.0.0.1 --inspector-port 9330 --var RP_ID:cf.localhost --var RP_ORIGINS:https://app.localhost:5443 \
  --var ALLOWED_ORIGINS:https://app.localhost:5443,http://localhost:5173 \
  --var EXTERNAL_SIGN_IN:true --var PUBLIC_ORIGIN:https://cf.localhost:8444 "$@" \
  --persist-to /tmp/claude-0/-home-user/20bcd46f-cefb-56b4-8905-7ffb49d5fe85/scratchpad/interop/cf-tls-state
