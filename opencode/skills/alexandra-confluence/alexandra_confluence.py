#!/usr/bin/env python3
"""CLI for Alexandra's Confluence at confluence.alexandra.dk.

This module is a thin entry point. All implementation lives in the
scripts/ package for better maintainability.

Form-login + session cookie auth. Cookies persist in
~/.alexandra-confluence/cookies.txt and are reused across invocations;
on session expiry the script silently re-authenticates and retries once.

Standard library only. See ./SKILL.md for usage.
"""

from __future__ import annotations

from scripts.main import main

if __name__ == "__main__":
    main()
