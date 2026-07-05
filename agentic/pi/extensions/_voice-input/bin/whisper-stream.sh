#!/usr/bin/env bash
# whisper-stream.sh — streaming wrapper for whisper-server
# Reads raw PCM s16le mono 16000 from stdin
# Emits JSONL {"type":"partial"|"final","text":"..."} events
# Tries whisper-server on 8081 (or PI_PTT_WHISPER_SERVER_URL), falls back gracefully

set -euo pipefail

# Server URL (can be overridden via env)
WHISPER_SERVER_URL="${PI_PTT_WHISPER_SERVER_URL:-http://localhost:8081}"

CHUNK_BYTES=32000
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

CHUNK_FILE="$TEMP_DIR/chunk.pcm"
ALL_AUDIO="$TEMP_DIR/all.pcm"
: > "$ALL_AUDIO"

# Check if whisper-server is available
check_server() {
    curl -s --connect-timeout 2 "$WHISPER_SERVER_URL/health" >/dev/null 2>&1
}

process_partial() {
    local chunk_file="$1"
    local wav_file="$TEMP_DIR/partial.wav"
    
    [ -s "$chunk_file" ] || return 0
    
    # Convert raw PCM to WAV
    if command -v ffmpeg >/dev/null 2>&1; then
        ffmpeg -y -f s16le -ar 16000 -ac 1 -i "$chunk_file" -ar 16000 "$wav_file" >/dev/null 2>&1 || return 0
    elif command -v sox >/dev/null 2>&1; then
        sox -t raw -r 16000 -e signed-integer -b 16 -c 1 "$chunk_file" -t wav "$wav_file" 2>/dev/null || return 0
    else
        return 0
    fi
    
    # Call whisper-server
    local result
    result=$(curl -s --connect-timeout 5 -X POST "$WHISPER_SERVER_URL/inference" \
        -F "file=@$wav_file" \
        -F "response_format=json" \
        -F "suppress_nst=true" 2>/dev/null) || return 0
    
    # Extract and emit text
    local text
    text=$(echo "$result" | jq -r '.text // empty' 2>/dev/null) || return 0
    
    if [ -n "$text" ]; then
        local escaped
        escaped=$(printf '%s' "$text" | jq -Rs '.')
        printf '{"type":"partial","text":%s}\n' "$escaped"
    fi
}

emit_final() {
    local audio_file="$1"
    local wav_file="$TEMP_DIR/final.wav"
    
    [ -s "$audio_file" ] || { echo '{"type":"final","text":""}'; return 0; }
    
    # Convert to WAV
    if command -v ffmpeg >/dev/null 2>&1; then
        ffmpeg -y -f s16le -ar 16000 -ac 1 -i "$audio_file" -ar 16000 "$wav_file" >/dev/null 2>&1
    elif command -v sox >/dev/null 2>&1; then
        sox -t raw -r 16000 -e signed-integer -b 16 -c 1 "$audio_file" -t wav "$wav_file" 2>/dev/null
    else
        echo '{"type":"final","text":""}'
        return 0
    fi
    
    # Transcribe with whisper-server
    local result
    result=$(curl -s --connect-timeout 5 -X POST "$WHISPER_SERVER_URL/inference" \
        -F "file=@$wav_file" \
        -F "response_format=json" \
        -F "suppress_nst=true" 2>/dev/null) || { echo '{"type":"final","text":""}'; return 0; }
    
    local text
    text=$(echo "$result" | jq -r '.text // empty' 2>/dev/null) || text=""
    
    if [ -n "$text" ]; then
        local escaped
        escaped=$(printf '%s' "$text" | jq -Rs '.')
        printf '{"type":"final","text":%s}\n' "$escaped"
    else
        echo '{"type":"final","text":""}'
    fi
}

# If no server, just collect audio and emit empty final (Pi will use WAV fallback)
if ! check_server; then
    # Server not available: drain stdin to ALL_AUDIO, then emit empty final
    # Pi's fallbackTranscribeFromStream will handle the actual transcription
    cat > "$ALL_AUDIO"
    echo '{"type":"final","text":""}'
    exit 0
fi

# Stream: read chunks, emit partials
while dd if=/dev/stdin bs=4096 count=$((CHUNK_BYTES / 4096)) 2>/dev/null > "$CHUNK_FILE"; do
    [ -s "$CHUNK_FILE" ] || break
    cat "$CHUNK_FILE" >> "$ALL_AUDIO"
    process_partial "$CHUNK_FILE"
done

emit_final "$ALL_AUDIO"
