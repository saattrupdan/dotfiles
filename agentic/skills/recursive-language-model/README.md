# RLM (Recursive Language Model) Skill

An agentic harness implementation of the Recursive Language Model pattern for processing arbitrarily long documents that exceed context window limits.

Based on [MIT paper "Recursive Language Models"](https://arxiv.org/abs/2512.24601) and adapted from [brainqub3/claude_code_RLM](https://github.com/brainqub3/claude_code_RLM).

## What is RLM?

RLM treats documents as external environments and recursively calls sub-LLMs over chunks of content, enabling analysis of documents of any length regardless of model context limits.

**Architecture:**
- **Root Agent**: Main agent orchestrating the task
- **Sub-LLM (llm_query)**: Subordinate agent for chunk-level analysis  
- **External Environment**: Persistent Python REPL with document state

## Quick Start

```bash
# 1. Initialize the REPL with your document
python3 /path/to/rlm_skill/scripts/rlm_repl.py init /path/to/large_document.txt

# 2. Scout the content
python3 scripts/rlm_repl.py exec -c 'print(peek(0, 3000))'

# 3. Search for patterns
python3 scripts/rlm_repl.py exec -c 'for m in grep("pattern", max_matches=5): print(m)'

# 4. Create chunks
python3 scripts/rlm_repl.py exec -c 'print("\\n".join(write_chunks("./chunks")))'
```

## Full Workflow Example

See `EXAMPLE.md` for a complete walkthrough of analyzing a large document.

## Files

- `SKILL.md` - Main skill definition with procedures
- `rlm-subcall.md` - Subordinate agent prompt profile  
- `scripts/rlm_repl.py` - Persistent Python REPL

## REPL Commands

| Command | Description |
|---------|-------------|
| `init <path>` | Load context file |
| `status [--show-vars]` | Show current state |
| `exec [-c "code"]` | Execute Python code |
| `export-buffers <path>` | Save buffers to file |
| `reset` | Clear all state |

## REPL Helper Functions

Functions available in REPL exec:

- `peek(start, end)` - View content portion with markers
- `grep(pattern, max_matches, window, flags)` - Search with context
- `chunk_indices(size, overlap)` - Get chunk boundaries
- `write_chunks(out_dir, size, overlap, prefix)` - Materialize chunks as files
- `add_buffer(text)` - Store intermediate results

## Agent Integration

Use with your agentic harness's subordinate agent capability:

```
Subordinate Agent:
  Profile: rlm-subcall
  Message: Query: Find all error messages
           
           Chunk file: ./chunks/chunk_0001.txt
```

## Best Practices

1. **Don't paste large content in main chat** - Use the REPL
2. **Use grep() to find relevant sections** - Then peek() for details
3. **Structure chunk outputs as JSON** - Easier to synthesize
4. **Synthesize in main conversation** - After collecting all evidence
5. **Clean up when done** - Use `reset` to clear state

## Compatible Agentic Harnesses

This skill uses standard patterns compatible with:
- Claude Code (Anthropic)
- Agent Zero
- Cursor
- Goose (Block)
- OpenAI Codex CLI
- GitHub Copilot
- Any agent framework supporting code execution and subordinate agents

## License

MIT - Based on original work by brainqub3
