#!/usr/bin/env bash
# Start zebrad on regtest in the background and wait for the RPC to answer.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC_PORT="${ZEBO_RPC_PORT:-8232}"
IDX_PORT="${ZEBO_INDEXER_PORT:-8233}"
LOG="ops/zebrad.log"
PIDFILE="ops/zebrad.pid"
CONFIG="ops/zebrad-regtest.toml"

ZEBRA_BIN="bin/zebrad"
if [ -x bin/zebrad-internal-miner ]; then ZEBRA_BIN="bin/zebrad-internal-miner"; fi

if [ ! -x "$ZEBRA_BIN" ]; then
  echo "no zebrad binary at $ZEBRA_BIN" >&2
  echo "Only a source build can mine, because the internal-miner feature is not" >&2
  echo "in the published release artifacts:" >&2
  echo "  bash ops/build-zebra.sh" >&2
  exit 1
fi

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "zebrad already running (pid $(cat "$PIDFILE"))"
  exit 0
fi

# Note: the miner address is NOT required to boot. With none configured the node
# starts and serves RPC, which is what fund.sh needs in order to call
# z_getnewaddress. Refusing to start without it deadlocked fund.sh <-> up.sh.

echo "starting zebrad (regtest), rpc on 127.0.0.1:${RPC_PORT}, indexer on 127.0.0.1:${IDX_PORT}"
nohup "./$ZEBRA_BIN" -c "$CONFIG" > "$LOG" 2>&1 &
echo $! > "$PIDFILE"

# Zebra's cookie auth expects HTTP Basic with the literal username "cookie" and
# the .cookie file contents as the password. The cookie is written *after* the
# node binds the port, so it has to be re-resolved on every poll.
cookie_file() {
  for c in "${ZEBO_COOKIE:-}" "$HOME/.cache/zebra/.cookie" "$PWD/ops/zebra.cookie"; do
    if [ -n "$c" ] && [ -s "$c" ]; then echo "$c"; return 0; fi
  done
  return 1
}

# Zebra's cookie file contains "__cookie__:<token>". HTTP Basic wants those split
# into username/password, so the prefix must be stripped -- sending the whole line
# as the password under username "cookie" does not authenticate. The cookie is
# written only after the node binds the port, so it is re-resolved every poll.
cookie_file() {
  for c in "${ZEBO_COOKIE:-}" "$HOME/.cache/zebra/.cookie" "$PWD/ops/zebra.cookie"; do
    if [ -n "$c" ] && [ -s "$c" ]; then echo "$c"; return 0; fi
  done
  return 1
}

cookie_creds() {
  local cf line
  cf=$(cookie_file) || return 1
  IFS= read -r line < "$cf" || return 1
  case "$line" in
    __cookie__:*) printf '%s' "__cookie__:${line#__cookie__:}" ;;
    *)            printf '%s' "$line" ;;
  esac
}

LAST_RESP=""
LAST_CODE=""
LAST_EXIT=""
for i in $(seq 1 60); do
  auth=()
  if creds=$(cookie_creds); then auth=(-u "$creds"); fi
  # getblockcount is an INDEXER method. It only exists on indexer_listen_addr,
  # never on the main rpc listen_addr.
  # `|| true`: curl's exit status must not trip `set -e` mid-startup.
  # stderr is folded into the response so the failure message shows curl's own
  # complaint instead of a bare exit code.
  LAST_RESP=$(curl -sS --max-time 3 "${auth[@]}" "http://127.0.0.1:${IDX_PORT}" \
       -H 'content-type: application/json' \
       --data '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' \
       -w '\n%{http_code}' 2>&1) && LAST_EXIT=0 || LAST_EXIT=$?
  LAST_CODE=$(printf '%s' "$LAST_RESP" | tail -n1)
  LAST_RESP=$(printf '%s' "$LAST_RESP" | sed '$d')
  if printf '%s' "$LAST_RESP" | grep -q '"result"'; then
    echo "zebrad is up after ${i}s (height ${LAST_RESP})"
    ./"$ZEBRA_BIN" --version 2>/dev/null || true
    exit 0
  fi
  sleep 1
done

echo "zebrad did not come up in 60s." >&2
if cf=$(cookie_file); then
  echo "auth cookie found at: $cf" >&2
else
  echo "NO AUTH COOKIE FOUND. Searched: \$ZEBO_COOKIE, \$HOME/.cache/zebra/.cookie, $PWD/ops/zebra.cookie" >&2
  echo "(zebrad writes it only after binding the port; cookie_dir comes from the config)" >&2
fi
echo "last indexer RPC: curl_exit=$LAST_EXIT http_code=${LAST_CODE:-<none>}" >&2
echo "raw: ${LAST_RESP:-<empty>}" >&2
echo "URL was: [http://127.0.0.1:${IDX_PORT}]  auth=[${auth[*]:-<none>}]" >&2
# Show the literal bytes the server sends. curl reporting "HTTP/0.9" means the
# status line is not parseable, which nc makes obvious.
echo "--- raw socket dump ---" >&2
BODY='{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}'
printf 'POST / HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: %s\r\n\r\n%s' \
  "${#BODY}" "$BODY" | timeout 3 nc 127.0.0.1 "$IDX_PORT" 2>/dev/null | head -c 400 >&2 || true
echo >&2
echo "--- end raw socket dump ---" >&2
tail -15 "$LOG" >&2
exit 1
