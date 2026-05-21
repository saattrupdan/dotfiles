#!/usr/bin/env python3
"""
RLM (Recursive Language Model) Persistent Python REPL

A persistent REPL for processing arbitrarily long documents in agentic workflows.
Part of the RLM skill for agentic harnesses.

Based on: https://github.com/brainqub3/claude_code_RLM
Paper: https://arxiv.org/abs/2512.24601

Usage:
    python rlm_repl.py init <context_path>     # Load context file
    python rlm_repl.py status [--show-vars]    # Show current state
    python rlm_repl.py exec [-c "code"]        # Execute Python code
    python rlm_repl.py export-buffers <path>   # Write buffers to file
    python rlm_repl.py reset                   # Delete state file

Helper functions available in exec:
    peek(start=0, end=1000)                    # View content portion
    grep(pattern, max_matches=20, window=120, flags=0)  # Search with context
    chunk_indices(size=200000, overlap=0)      # Get chunk boundaries
    write_chunks(out_dir, size=200000, overlap=0, prefix='chunk')  # Materialize chunks
    add_buffer(text)                           # Store intermediate results
"""

import argparse
import io
import pickle
import re
import sys
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

STATE_FILE = Path(__file__) / ".rlm" / "state.pkl"
MAX_OUTPUT_CHARS = 8000

def load_state():
    if STATE_FILE.exists():
        with open(STATE_FILE, "rb") as f:
            return pickle.load(f)
    return {}

def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_FILE, "wb") as f:
        pickle.dump(state, f)

def cmd_init(context_path: str):
    path = Path(context_path).expanduser()
    if not path.exists():
        print(f"Error: File not found: {path}", file=sys.stderr)
        sys.exit(1)
    content = path.read_text(encoding="utf-8", errors="ignore")
    state = {
        "context_path": str(path),
        "content": content,
        "buffers": [],
        "chunk_size": 200000,
    }
    save_state(state)
    print(f"Loaded {len(content)} chars from {path}")
    print("Use 'python rlm_repl.py status' to verify.")

def cmd_status(show_vars: bool = False):
    state = load_state()
    if not state:
        print("No active context. Use 'init <path>' first.")
        return
    print(f"Context path: {state.get('context_path', 'N/A')}")
    print(f"Content size: {len(state.get('content', ''))} chars")
    print(f"Chunk size:   {state.get('chunk_size', 200000)}")
    print(f"Buffers:      {len(state.get('buffers', []))}")
    if show_vars:
        print(f"\nVariables: {', '.join(state.keys())}")
        print("Helper functions: peek(), grep(), chunk_indices(), write_chunks(), add_buffer()")

def cmd_exec(code_str: str = None):
    state = load_state()
    if "content" not in state:
        print("No active context. Use 'init <path>' first.", file=sys.stderr)
        sys.exit(1)

    content = state["content"]
    chunk_size = state.get("chunk_size", 200000)

    def peek(start=0, end=1000):
        snippet = content[start:end]
        total = len(content)
        return f"\n[--- chunk bytes {start}-{end} ({len(snippet)} chars) ---]\n{snippet}\n[--- (total {total} chars) ---]"

    def grep(pattern: str, max_matches: int = 20, window: int = 120, flags: int = 0):
        matches = []
        for m in re.finditer(pattern, content, flags):
            start = max(m.start() - window, 0)
            end = min(m.end() + window, len(content))
            snippet = content[start:end]
            matches.append(f"\n[match at {m.start()}-{m.end()}]\n{snippet}")
            if len(matches) >= max_matches:
                break
        return matches

    def chunk_indices(size: int = chunk_size, overlap: int = 0):
        indices = []
        start = 0
        while start < len(content):
            end = min(start + size, len(content))
            indices.append((start, end))
            start += size - overlap
            if end == len(content):
                break
        return indices

    def write_chunks(out_dir: str, size: int = chunk_size, overlap: int = 0, prefix: str = "chunk"):
        out_path = Path(out_dir)
        out_path.mkdir(parents=True, exist_ok=True)
        indices = chunk_indices(size, overlap)
        written = []
        for i, (start, end) in enumerate(indices):
            chunk_file = out_path / f"{prefix}_{i:04d}.txt"
            chunk_file.write_text(content[start:end], encoding="utf-8")
            written.append(str(chunk_file))
        return written

    def add_buffer(text: str):
        state["buffers"].append(text)
        save_state(state)
        return f"Buffer #{len(state['buffers'])} added."

    if code_str is None:
        code_str = sys.stdin.read()

    exec_globals = {
        "__builtins__": __builtins__,
        "content": content,
        "context_path": state.get("context_path"),
        "buffers": state.get("buffers", []),
        "chunk_size": chunk_size,
        "peek": peek,
        "grep": grep,
        "chunk_indices": chunk_indices,
        "write_chunks": write_chunks,
        "add_buffer": add_buffer,
    }

    f = io.StringIO()
    with redirect_stdout(f), redirect_stderr(f):
        try:
            exec(code_str, exec_globals)
        except Exception as e:
            print(f"Error: {e}")

    output = f.getvalue()
    if len(output) > MAX_OUTPUT_CHARS:
        sys.stdout.write(output[:MAX_OUTPUT_CHARS])
        sys.stdout.write(f"\n... [Output truncated. Exceeded {MAX_OUTPUT_CHARS} chars] ...\n")
    else:
        sys.stdout.write(output)

    save_state(state)

def cmd_export_buffers(out_path: str):
    state = load_state()
    buffers = state.get("buffers", [])
    Path(out_path).write_text("\n---\n".join(buffers), encoding="utf-8")
    print(f"Exported {len(buffers)} buffers to {out_path}")

def cmd_reset():
    if STATE_FILE.exists():
        STATE_FILE.unlink()
        print("State cleared.")
    else:
        print("No state to clear.")

def main():
    parser = argparse.ArgumentParser(description="RLM Persistent Python REPL")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_init = subparsers.add_parser("init", help="Load context file")
    p_init.add_argument("context_path", help="Path to context file")

    p_status = subparsers.add_parser("status", help="Show current state")
    p_status.add_argument("--show-vars", action="store_true", help="Show available variables")

    p_exec = subparsers.add_parser("exec", help="Execute Python code")
    p_exec.add_argument("-c", dest="code", help="Python code to execute")

    p_export = subparsers.add_parser("export-buffers", help="Write buffers to file")
    p_export.add_argument("out_path", help="Output file path")

    p_reset = subparsers.add_parser("reset", help="Delete state file")

    args = parser.parse_args()

    if args.command == "init":
        cmd_init(args.context_path)
    elif args.command == "status":
        cmd_status(args.show_vars)
    elif args.command == "exec":
        cmd_exec(args.code)
    elif args.command == "export-buffers":
        cmd_export_buffers(args.out_path)
    elif args.command == "reset":
        cmd_reset()

if __name__ == "__main__":
    main()
