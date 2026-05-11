#!/usr/bin/env python3
"""Argument parser builder for the Confluence CLI.

Defines all subcommands, arguments, and help text using argparse.
"""

from __future__ import annotations

import argparse


def _build_parser() -> argparse.ArgumentParser:
    """Build and return the CLI argument parser.

    Returns:
        Configured ArgumentParser instance.
    """
    parser = argparse.ArgumentParser(
        description="CLI for Alexandra's Confluence.",
    )
    sub = parser.add_subparsers(dest="resource", required=True)

    def _raw(p: argparse.ArgumentParser) -> None:
        p.add_argument("--raw", action="store_true")

    # ── spaces ──
    p = sub.add_parser("spaces", help="Manage spaces")
    sp = p.add_subparsers(dest="operation", required=True)

    pl = sp.add_parser("list", help="List all spaces")
    pl.add_argument("--limit", type=int, default=1000)
    pl.add_argument("--start", type=int, default=0)
    _raw(pl)

    pr = sp.add_parser("read", help="Read a space by key")
    pr.add_argument("--key", required=True)
    _raw(pr)

    pc = sp.add_parser("create", help="Create a new space")
    pc.add_argument("--key", required=True)
    pc.add_argument("--name", required=True)
    pc.add_argument("--description", help="Plain text description")
    _raw(pc)

    pu = sp.add_parser("update", help="Update a space")
    pu.add_argument("--key", required=True)
    pu.add_argument("--name", help="New name")
    pu.add_argument("--description", help="New plain text description")
    _raw(pu)

    ss = sp.add_parser("search", help="Search spaces")
    ss.add_argument("query", nargs="?", help="Title search shorthand")
    ss.add_argument("--cql", help="Full CQL query (overrides query)")
    ss.add_argument("--limit", type=int, default=20)
    _raw(ss)

    # ── pages ──
    p = sub.add_parser("pages", help="Manage pages")
    pp = p.add_subparsers(dest="operation", required=True)

    pl = pp.add_parser("list", help="List pages in a space")
    pl.add_argument("--space-key", required=True)
    pl.add_argument("--limit", type=int, default=20)
    _raw(pl)

    ps = pp.add_parser("search", help="Search pages")
    ps.add_argument("query", nargs="?", help="Title search shorthand")
    ps.add_argument("--cql", help="Full CQL query (overrides query)")
    ps.add_argument("--limit", type=int, default=20)
    _raw(ps)

    pr = pp.add_parser("read", help="Read a single page by key or ID")
    pg_group = pr.add_mutually_exclusive_group(required=True)
    pg_group.add_argument("--key")
    pg_group.add_argument("--id")
    pr.add_argument(
        "--body-format",
        choices=["auto", "text", "html"],
        default="auto",
        dest="body_format",
    )
    _raw(pr)

    pc = pp.add_parser("create", help="Create a new page")
    pc.add_argument("--space-key", required=True)
    pc.add_argument("--title", required=True)
    pc.add_argument("--body", required=True)
    pc.add_argument("--parent", help="Parent page ID")
    _raw(pc)

    pu = pp.add_parser("update", help="Update an existing page")
    pu.add_argument("--id", required=True)
    pu.add_argument("--body", required=True)
    pu.add_argument("--title", help="New title (optional)")
    pu.add_argument("--minor-edit", action="store_true")
    _raw(pu)

    # ── projects ──
    p = sub.add_parser("projects", help="Manage projects")
    pj = p.add_subparsers(dest="operation", required=True)

    pj_list = pj.add_parser("list", help="List project pages")
    pj_list.add_argument("--space-key", default="PROJ")
    pj_list.add_argument("--limit", type=int, default=20)
    _raw(pj_list)

    pj_read = pj.add_parser("read", help="Read a project page")
    pj_read_grp = pj_read.add_mutually_exclusive_group(required=True)
    pj_read_grp.add_argument("--key")
    pj_read_grp.add_argument("--id")
    pj_read.add_argument(
        "--body-format",
        choices=["auto", "text", "html"],
        default="auto",
        dest="body_format",
    )
    _raw(pj_read)

    pj_create = pj.add_parser(
        "create",
        help="Create a project page with Alexandra Way template",
    )
    pj_create.add_argument("--space-key", default="PROJ")
    pj_create.add_argument("--title", required=True)
    pj_create.add_argument("--client", required=True)
    pj_create.add_argument("--owner", required=True)
    pj_create.add_argument("--budget", default="Ikke fastsat")
    _raw(pj_create)

    pj_update = pj.add_parser("update", help="Update a project page")
    pj_update.add_argument("--id", required=True)
    pj_update.add_argument("--body", required=True)
    pj_update.add_argument("--title", help="New title (optional)")
    pj_update.add_argument("--minor-edit", action="store_true")
    _raw(pj_update)

    # ── ai-lab-slides ──
    p = sub.add_parser(
        "ai-lab-slides",
        help="Manage AI Lab slide deck entries",
    )
    alp = p.add_subparsers(dest="operation", required=True)

    alp_read = alp.add_parser(
        "read",
        help="Read a specific slide entry by ID",
    )
    grp = alp_read.add_mutually_exclusive_group(required=True)
    grp.add_argument(
        "--id",
        help="Slide ID in cat:index format (e.g. nlp:3)",
    )
    grp.add_argument("--category", help="Category key")
    alp_read.add_argument(
        "--index",
        type=int,
        help="0-based index within category",
    )
    _raw(alp_read)

    alp_create = alp.add_parser(
        "create",
        help="Create a new slide entry",
    )
    alp_create.add_argument(
        "--category",
        required=True,
        help=(
            "Category: about-us, themed, client, courses, "
            "presentations, nlp, energy, healthcare, iot"
        ),
    )
    alp_create.add_argument(
        "--title",
        required=True,
        help="Title / Description",
    )
    alp_create.add_argument("--date", help="Date (YYYY-MM-DD)")
    alp_create.add_argument("--owner-key", help="Confluence user key")
    alp_create.add_argument("--language", help="Language code (DA, EN, FR, etc.)")
    alp_create.add_argument("--slides", help="Attachment filename or link")
    alp_create.add_argument("--note", help="Extra note")
    _raw(alp_create)

    alp_update = alp.add_parser(
        "update",
        help="Update a slide entry",
    )
    alp_update.add_argument("--category", required=True)
    alp_update.add_argument(
        "--index",
        type=int,
        required=True,
        help="0-based index of the slide row to update",
    )
    alp_update.add_argument("--title", help="New title / Description")
    alp_update.add_argument("--date", help="New date (YYYY-MM-DD)")
    alp_update.add_argument("--owner-key", help="New Confluence user key")
    alp_update.add_argument("--language", help="New language code")
    alp_update.add_argument("--slides", help="New attachment filename or link")
    alp_update.add_argument("--note", help="New note")
    _raw(alp_update)

    alist = alp.add_parser(
        "list",
        help="List all slides across all categories",
    )
    _raw(alist)

    all_s = alp.add_parser(
        "search",
        help="Search slides across all categories",
    )
    all_s.add_argument("query", nargs="?", help="Title search shorthand")
    all_s.add_argument("--cql", help="Full CQL query (overrides query)")
    _raw(all_s)

    # ── whoami ──
    whoami_p = sub.add_parser("whoami", help="Show current user")
    _raw(whoami_p)

    # ── auth ──
    auth_p = sub.add_parser("auth", help="Force re-authentication")
    _raw(auth_p)

    return parser
