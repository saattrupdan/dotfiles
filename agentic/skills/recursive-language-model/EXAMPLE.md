# RLM Skill Usage Example

This example demonstrates analyzing a large source code file using the RLM (Recursive Language Model) skill.

## Scenario

You have a large C# file (834KB) with a massive `else if` chain that you want to analyze and suggest converting to a lookup table (LUT) approach.

## Prerequisites

- RLM skill installed in your agent's skills directory
- A large text file to analyze

## Step-by-Step Workflow

### 1. Initialize the REPL

Load your context file into the persistent REPL:

```bash
python3 /path/to/rlm_skill/scripts/rlm_repl.py init /path/to/LargeSourceFile.cs
```

Output:
```
Loaded 834544 chars from /path/to/LargeSourceFile.cs
Use 'python rlm_repl.py status' to verify.
```

### 2. Verify Status

Check that the context loaded correctly:

```bash
python3 /path/to/rlm_skill/scripts/rlm_repl.py status --show-vars
```

Output:
```
Context path: /path/to/LargeSourceFile.cs
Content size: 834544 chars
Chunk size:   200000
Buffers:      0

Variables: __content, __context_path, __buffers, __chunk_size
Helper functions: peek(), grep(), chunk_indices(), write_chunks(), add_buffer()
```

### 3. Scout the Content

Peek at the beginning to understand the file structure:

```bash
python3 /path/to/rlm_skill/scripts/rlm_repl.py exec -c 'print(peek(0, 2000))'
```

### 4. Search for Patterns

Find occurrences of the pattern you're analyzing:

```bash
python3 /path/to/rlm_skill/scripts/rlm_repl.py exec -c 'matches = grep("else if", max_matches=20, window=100); print(f"Found {len(matches)} matches"); print("\n".join(matches[:5]))'
```

### 5. Create Chunks

Split the file into manageable chunks for subordinate analysis:

```bash
python3 /path/to/rlm_skill/scripts/rlm_repl.py exec -c 'chunks = write_chunks("./rlm_chunks", size=150000, overlap=1000); print(f"Created {len(chunks)} chunks"); print("\n".join(chunks))'
```

Output:
```
Created 6 chunks
./rlm_chunks/chunk_0000.txt
./rlm_chunks/chunk_0001.txt
./rlm_chunks/chunk_0002.txt
./rlm_chunks/chunk_0003.txt
./rlm_chunks/chunk_0004.txt
./rlm_chunks/chunk_0005.txt
```

### 6. Delegate to Sub-LLM

For each chunk, use your agentic harness's subordinate agent capability with the `rlm-subcall` profile:

**Subordinate Query (Chunk 0):**
```
Profile: rlm-subcall
Message: Query: Analyze the long chain of `else if` clauses in this C# source code and suggest how to convert the if-else chain into a lookup table (LUT) based approach. Focus on:
1. Identifying the pattern of type checking
2. Counting how many else-if branches exist
3. Suggesting a Dictionary<Type, Action> or similar LUT structure
4. Any challenges in converting to LUT approach

Chunk file: ./rlm_chunks/chunk_0000.txt

Extract relevant information from this chunk.
```

**Repeat for chunks 1-5**, adjusting the chunk file path each time.

### 7. Synthesize Results

After collecting all subordinate responses, synthesize the findings:

- Total branches found: ~600-750
- Patterns identified: type checking, arrays, lists, enums, dictionaries
- LUT approach: Dictionary<Type, Action<...>>
- Challenges: auto-generated code, collection variations, method signatures

### 8. Provide Final Answer

Present the comprehensive analysis to the user with:
- Summary statistics
- Pattern breakdown
- LUT conversion recommendation
- Implementation challenges

### 9. Clean Up (Optional)

When done, clear the REPL state:

```bash
python3 /path/to/rlm_skill/scripts/rlm_repl.py reset
```

## Key Takeaways

1. **Don't paste large content in main chat** - Use the REPL and subordinates
2. **Use grep() to find relevant sections** - Then peek() for details
3. **Structure chunk outputs** - JSON or markdown for easier synthesis
4. **Synthesize in main conversation** - After collecting all evidence
5. **Clean up when done** - Use `reset` to clear state

## Tips for Different Agentic Harnesses

### Claude Code
Use the subordinate agent feature with the rlm-subcall profile.

### Agent Zero / Agent 0
Use the `call_subordinate` tool with `profile: rlm-subcall`.

### Cursor / Goose / Codex CLI
Configure the rlm-subcall.md as a prompt file for sub-agent tasks.

### Generic Agents
Load rlm-subcall.md as the system prompt for chunk analysis tasks.
