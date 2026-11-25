#!/bin/bash
# Replays known failures against the real page and server. Exit code = number of failing cases.
# Asserts only what a user or the upstream can observe.
cd "$(dirname "$0")" || exit 99
export VERIFY_RUN="${VERIFY_RUN:-regressions}"
C=./ctl.mjs; FAILS=0
$C stop >/dev/null; $C launch || exit 99
trap '$C stop' EXIT
REC="document.getElementById('micBtn').classList.contains('recording')"
IDLE="!$REC && document.getElementById('statusText').textContent!=='连接中…'"
port() { node -p "JSON.parse(require('fs').readFileSync('.runs/$VERIFY_RUN/scratch/state.json')).app"; }
pid() { node -p "JSON.parse(require('fs').readFileSync('.runs/$VERIFY_RUN/scratch/state.json')).pids.server"; }
js() { $C eval "$1" | tr -d '\n'; }
appends() { $C upstream log | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).sessions.at(-1)?.appends??0))"; }
fresh() { $C upstream reset >/dev/null; $C open; }
verdict() { $C snap "$1" >/dev/null 2>&1; if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1: $3"; FAILS=$((FAILS+1)); fi; }

fresh; $C upstream set finishDelay=1500 finalEvery=40 >/dev/null
$C click '#micBtn'; $C wait "$REC" >/dev/null; sleep 1
$C click '#micBtn'; $C click '#micBtn'; $C wait "$REC" >/dev/null; sleep 4.5
A=$(appends); sleep 1; B=$(appends)
verdict restart-survives-old-session-ending "$([ "$(js "$REC")" = true ] && [ "$B" -gt "$A" ] && echo 1)" "recording=$(js "$REC") packets $A -> $B in 1 s"
OLD=$(js "[...document.querySelectorAll('.seg:not(.interim) p')].some(p=>p.textContent.includes('session '+($($C upstream log | grep -c '"n"')-1)+' sentence 1'))")
verdict old-session-last-sentence-is-kept "$([ "$OLD" = true ] && echo 1)" "last sentence of the stopped session is not in the transcript"
# A cut sentence shows as a truncated row, or as a second row when its real final result arrives.
NEWCUT=$(js "(r=>new Set(r).size!==r.length||r.some(t=>!/session \\d+ sentence \\d+\$/.test(t)))([...document.querySelectorAll('.seg:not(.interim) p')].map(p=>p.textContent))")
verdict new-sentence-is-not-cut "$([ "$NEWCUT" = false ] && echo 1)" "$(js "[...document.querySelectorAll('.seg p')].map(p=>p.textContent)")"

fresh; $C upstream set handshake=reject >/dev/null; $C click '#micBtn'; sleep 2
verdict rejected-upstream-does-not-show-recording "$([ "$(js "$REC || document.getElementById('micBtn').disabled")" = false ] && echo 1)" "the button shows recording, or stays disabled"

fresh; $C upstream set closeOnUpdate=1 >/dev/null; $C click '#micBtn'; sleep 2
verdict early-close-does-not-show-recording "$([ "$(js "$REC || document.getElementById('micBtn').disabled")" = false ] && echo 1)" "the button shows recording, or stays disabled"

fresh; $C select '#trans' '*>ja'; $C click '#micBtn'; $C wait "$REC" >/dev/null; $C select '#engine' live; sleep 3
TR=$(js "[...document.querySelectorAll('.seg:not(.interim)')].length>0 && [...document.querySelectorAll('.seg:not(.interim)')].slice(-2).every(e=>/Japanese/.test(e.querySelector('.tr .txt')?.textContent))")
verdict engine-switch-waits-for-next-recording "$([ "$TR" = true ] && echo 1)" "sentences after the switch lost their translation"
$C click '#micBtn'; sleep 1; $C select '#engine' asr

alive() { kill -0 "$(pid)" 2>/dev/null && echo 1; }
restart() { [ "$(alive)" ] || { $C stop >/dev/null; $C launch >/dev/null; }; }
node -e "
const s=require('net').connect($(port),'127.0.0.1',()=>s.write('POST /api/translate HTTP/1.1\r\nHost: x\r\nContent-Length: 999\r\n\r\n{'));
s.on('error',()=>{});setTimeout(()=>s.destroy(),200);setTimeout(()=>process.exit(),600)"; sleep 0.4
verdict aborted-request-body-keeps-server-up "$(alive)" "server process exited"; restart
node -e "
const s=require('net').connect($(port),'127.0.0.1',()=>s.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
s.once('data',()=>s.write(Buffer.from([0xf1,0x80,0,0,0,0])));s.on('error',()=>{});setTimeout(()=>process.exit(),600)"; sleep 0.4
verdict malformed-frame-keeps-server-up "$(alive)" "server process exited"; restart
BAD=$($C http POST /api/translate nope | head -1)
verdict bad-json-is-a-client-error "$([ "$BAD" = 400 ] && echo 1)" "status $BAD"
exit $FAILS
