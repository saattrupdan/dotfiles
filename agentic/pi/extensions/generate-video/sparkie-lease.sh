#!/usr/bin/env bash
# Hold a host-local lease through generation and download, not just server startup.
set -euo pipefail
exec 9>"$HOME/model-servers/minimax-h3/pi-generation.lock"
flock -n 9 || { echo 'Another Pi session is using MiniMax-H3.' >&2; exit 1; }

container=
launcher=
started=0
ready=0
action=release

cleanup() {
	local current jobs
	if [[ $action == preserve ]]; then
		echo 'WARNING MiniMax-H3 left running because submission outcome is unknown.'
		return
	fi
	if [[ -z $container && $started == 1 ]]; then
		# A launch can still be in its admission checks when the caller cancels.
		if [[ -n $launcher ]] && kill -0 "$launcher" 2>/dev/null; then
			kill "$launcher" 2>/dev/null || true
			wait "$launcher" 2>/dev/null || true
		fi
		container=$(docker inspect --format '{{.Id}}' minimax-h3 2>/dev/null) || return 0
	fi
	[[ -n $container ]] || return 0
	current=$(docker inspect --format '{{.Id}}' minimax-h3 2>/dev/null) || return 0
	if [[ $current != "$container" ]]; then
		echo 'WARNING MiniMax-H3 container changed; replacement left running.'
		return
	fi
	if [[ $ready == 1 || $started == 0 ]]; then
		if ! jobs=$(curl -fsS --max-time 10 'http://127.0.0.1:30010/v1/videos?limit=100'); then
			echo 'WARNING Cannot inspect MiniMax-H3 jobs; server left running.'
			return
		fi
		if ! jq -e '(.data | type == "array") and (.has_more == false) and all(.data[]; .status == "completed" or .status == "failed" or .status == "cancelled")' <<< "$jobs" >/dev/null; then
			echo 'WARNING MiniMax-H3 has active or unverified jobs; server left running.'
			return
		fi
	fi
	current=$(docker inspect --format '{{.Id}}' minimax-h3 2>/dev/null) || return 0
	if [[ $current != "$container" ]]; then
		echo 'WARNING MiniMax-H3 container changed; replacement left running.'
		return
	fi
	if docker stop --time 20 "$container" >/dev/null; then
		echo STOPPED
	else
		echo 'WARNING Failed to stop MiniMax-H3.'
	fi
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
