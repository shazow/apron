#!/bin/sh
cd /home/user/apron-server-cloudflare
exec npx wrangler dev --port 8787 --ip 127.0.0.1 --var RP_ID:localhost --var RP_ORIGINS:http://localhost:5173 \
  --var ALLOWED_ORIGINS:http://localhost:5173,http://localhost:8787,http://127.0.0.1:5173 \
  --var EXTERNAL_SIGN_IN:true --var PUBLIC_ORIGIN:http://localhost:8787 "$@" \
  --persist-to /tmp/claude-0/-home-user/20bcd46f-cefb-56b4-8905-7ffb49d5fe85/scratchpad/interop/cf-state
