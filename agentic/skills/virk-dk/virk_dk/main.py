#!/usr/bin/env python3
"""CLI for virk.dk (editorial/GraphQL) and the CVR distribution API."""

from __future__ import annotations

import argparse

from . import cvr, web


def main() -> None:
    """Entry point: parse arguments and dispatch to the selected command."""
    p = argparse.ArgumentParser(prog="virk", description=__doc__)
    sub = p.add_subparsers(dest="group", required=True)
    web.add_group(sub)
    cvr.add_group(sub)
    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
