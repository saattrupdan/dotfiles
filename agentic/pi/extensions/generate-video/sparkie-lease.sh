#!/usr/bin/env bash
# Coordinate generation/download; the server owns its 30-minute idle shutdown.
set -euo pipefail
exec 9>"$HOME/model-servers/minimax-h3/pi-generation.lock"
flock -n 9 || { echo 'Another Pi session is using MiniMax-H3.' >&2; exit 1; }

container=
launcher=
started=0
ready=0
action=release

cleanup() {
	if [[ $action == preserve ]]; then
		echo 'WARNING MiniMax-H3 left running because submission outcome is unknown.'
		return
	fi
	# Never infer launch ownership from the shared container name. Only interrupt
	# our attached launcher if cancellation arrives before it reports readiness.
	if [[ $ready == 0 && $started == 1 && -n $launcher ]] && kill -0 "$launcher" 2>/dev/null; then
		kill "$launcher" 2>/dev/null || true
		wait "$launcher" 2>/dev/null || true
	fi
	# Ready/adopted servers expire themselves, including when started outside Pi.
}
trap cleanup EXIT

container=$(docker inspect --format '{{.Id}}' minimax-h3 2>/dev/null) || container=
if [[ -n $container ]]; then
	image=$(docker inspect --format '{{.Config.Image}}' "$container")
	[[ $image == minimax-h3-lora:* ]] || { echo 'Unexpected MiniMax-H3 container image.' >&2; container=; exit 1; }
else
	started=1
	nohup bash "$HOME/model-servers/minimax-h3/start.sh" </dev/null >"$HOME/model-servers/minimax-h3/pi-generation.log" 2>&1 9>&- &
	launcher=$!
fi

deadline=$((SECONDS + 1200))
while ((SECONDS < deadline)); do
	if [[ -z $container ]]; then
		container=$(docker inspect --format '{{.Id}}' minimax-h3 2>/dev/null) || container=
	fi
	if [[ -n $container ]] && curl -fsS --max-time 2 http://127.0.0.1:30010/health >/dev/null; then
		ready=1
		echo READY
		read -r action || action=release
		exit 0
	fi
	if [[ $started == 1 ]] && ! kill -0 "$launcher" 2>/dev/null; then
		echo 'MiniMax-H3 startup failed; inspect ~/model-servers/minimax-h3/pi-generation.log.' >&2
		exit 1
	fi
	# Unlike sleep, this observes cancellation/EOF while the model is loading.
	if read -r -t 1 action; then
		exit 0
	else
		status=$?
		[[ $status -gt 128 ]] || exit 0
	fi
done
echo 'MiniMax-H3 startup timed out.' >&2
exit 1
