---
name: commit
description: Conventions when committing code with git.
license: MIT
compatibility: opencode
metadata:
  triggers: commit, git
---

## Commit Conventions

We use the Conventional Commits specification for our commit messages. You can find the
documentation of this here: <https://www.conventionalcommits.org/>

The Conventional Commits specification is a lightweight convention on top of commit
messages. Commit messages should be structured as follows:

```text
<type>: <description>

[optional body]
```

The types can be the following:

- `fix`: Fixed a bug
- `feat`: Added a new feature
- `docs`: Documentation only changes
- `test`: Anything that only affected tests
- `style`: Changes that do not affect the meaning of the code (e.g., formatting)
- `chore`: Changes that don’t modify src or test files (e.g., dependencies, makefile)

The description should be short and concise, and should not exceed 50 characters.

The optional body can be longer, if it is a large change that requires more explanation.
In almost all cases, this is not used, however.
