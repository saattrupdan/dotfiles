#!/usr/bin/env bash
# whisper-stream.sh — streaming wrapper for whisper-server
# Reads raw PCM s16le mono 16000 from stdin
# Emits JSONL {"type":"partial"|"final","text":"..."} events
#
# Usage: PI_PTT_STREAM_CMD="$PWD/bin/whisper-stream.sh" pi
#
# Buffers audio in ~1s chunks, calls whisper-server for partials.
# On stdin EOF, emits final transcription of all accumulated audio.

set -euo pipefail

CHUNK_BYTES=32000           # ~1 second at 16kHz * 2 bytes/sample
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

CHUNK_FILE="$TEMP_DIR/chunk.pcm"
ALL_AUDIO="$TEMP_DIR/all.pcm"
: > "$ALL_AUDIO"

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
    result=$(curl -s -X POST "http://localhost:8080/inference" \
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
    result=$(curl -s -X POST "http://localhost:8080/inference" \
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

# Stream: read chunks, emit partials
while dd if=/dev/stdin bs=4096 count=$((CHUNK_BYTES / 4096)) 2>/dev/null > "$CHUNK_FILE"; do
    [ -s "$CHUNK_FILE" ] || break
    cat "$CHUNK_FILE" >> "$ALL_AUDIO"
    process_partial "$CHUNK_FILE"
done

emit_final "$ALL_AUDIO"
