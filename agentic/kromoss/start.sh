#!/usr/bin/env bash
# Keep the HTTP parent alive; each request owns a separate model process.
set -euo pipefail
root="$(dirname "$(readlink -f "$0")")"
snapshot="$HOME/.cache/huggingface/hub/models--lodestones--Kromoss/snapshots/a4fe97449297af2e3be7841e1c18e431f3b06031"
image="moss-image-omni:pr8926-de2e050"
test -r "$snapshot/8-steps-dmd-lora.safetensors"
test -r "$root/src/kromoss/worker.py"
docker image inspect "$image" >/dev/null
if ss -ltnH sport = :30006 | grep -q .; then
  echo 'Port 30006 is occupied' >&2
  exit 1
fi
awk '/MemAvailable:/ {exit !($2 > 73400320)}' /proc/meminfo || {
  echo 'Less than 70 GiB memory available' >&2
  exit 1
}
exec docker run --rm --init --name kromoss --gpus 'device=0' --ipc=host \
  --memory=56g --memory-swap=56g --pids-limit=1024 --stop-timeout=30 \
  --publish 127.0.0.1:30006:8000 \
  --mount "type=bind,src=$HOME/.cache/huggingface,dst=/root/.cache/huggingface,readonly" \
  --mount "type=bind,src=$root/src,dst=/app/src,readonly" \
  -e PYTHONPATH=/app/src \
  -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 \
  -e HF_MODULES_CACHE=/tmp/hfmodules -e HF_HOME=/tmp/hfhome \
  -e KROMOSS_MODEL="/root/.cache/huggingface/hub/models--lodestones--Kromoss/snapshots/a4fe97449297af2e3be7841e1c18e431f3b06031" \
  --entrypoint python3 "$image" -m uvicorn kromoss.server:create_app --factory \
  --host 0.0.0.0 --port 8000 --workers 1 --timeout-graceful-shutdown 15
