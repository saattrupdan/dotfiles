#!/usr/bin/env python3
"""Resource handler for Confluence project pages.

Wraps the Pages resource with project-specific template creation.
"""

from __future__ import annotations

import html
import typing as t
import urllib.parse

from ..auth import BASE, resolve_page_id
from ..http import _request_json
from ..utils.parsing import emit_json
from .pages import Pages


_PROJECT_TEMPLATE: str = """\
<h1>Projekt: {title}</h1>
<ac:structured-macro ac:name="toc">
  <ac:parameter ac:name="minHeaders">2</ac:parameter>
  <ac:parameter ac:name="maxHeaders">6</ac:parameter>
  <ac:parameter ac:name="include">.*</ac:parameter>
  <ac:parameter ac:name="style">disc</ac:parameter>
</ac:structured-macro>

<h2>Projektinfo</h2>
<table class="wrapped confstyle">
<thead><tr><th>felt</th><th>v\u00e6rdi</th></tr></thead>
<tbody>
<tr><td>Projektnavn</td><td>{title}</td></tr>
<tr><td>Klient / kunde</td><td>{client}</td></tr>
<tr><td>Projektansvarlig</td><td>{owner}</td></tr>
<tr><td>Intern Projektejer</td><td>{owner}</td></tr>
<tr><td>Budget (Alexandra Instituttets Andel)</td><td>{budget}</td></tr>
<tr><td>Projekttype</td><td>Under udvikling</td></tr>
<tr><td>Projektslut</td><td>Ikke fastsat</td></tr>
<tr><td>Projektkode</td><td>IKKE Tildelt</td></tr>
<tr><td>Status</td><td>Under initiering</td></tr>
<tr><td>Skabelon</td><td>The Alexandra Way</td></tr>
</tbody>
</table>

<h2>Projektbeskrivelse</h2>
<p>Udfyld projektbeskrivelsen her.</p>

<h2>Tjeklister</h2>
<h3>Initiering</h3>
<ac:structured-macro ac:name="excerpt">
  <ac:parameter ac:name="restrictToPage">225903078</ac:parameter>
</ac:structured-macro>
<h3>Eksekvering</h3>
<ac:structured-macro ac:name="excerpt">
  <ac:parameter ac:name="restrictToPage">225903164</ac:parameter>
</ac:structured-macro>
<h3>Afslutning</h3>
<ac:structured-macro ac:name="excerpt">
  <ac:parameter ac:name="restrictToPage">225903170</ac:parameter>
</ac:structured-macro>

<h2>Administrative opgaver</h2>
<ul><li>Opret projekt i system</li>
<li>Fastl\u00e6g budget og resurser</li>
<li>Identific\u00e9r interessenter</li>
<li>Planl\u00e6g f\u00f8rste milestone</li></ul>

<h2>Projektledelsesopgaver</h2>
<ul><li>Lav projektplan</li>
<li>S\u00e6t op projektstyregruppe</li>
<li>Fastl\u00e6g rapporteringsrutiner</li></ul>

<h2>Softwareudviklingsopgaver</h2>
<p>Udfyld softwareudviklingsopgaver her.</p>

<h2>Milestone oversigt</h2>
<table class="wrapped confstyle">
<thead><tr><th>Milestone</th><th>Dato</th><th>Status</th></tr></thead>
<tbody><tr><td>MVP</td><td>Ikke fastsat</td><td>Planlagt</td></tr></tbody>
</table>"""


class Projects(Pages):
    """Manage project pages (wraps the Pages class)."""

    @staticmethod
    def size(opener: t.Any, args: t.Any) -> None:
        """Total number of project pages."""
        cql = 'space=PROJ AND title~"Projektoverblik"'
        qs = urllib.parse.urlencode({"cql": cql, "limit": 1})
        data = _request_json(opener, f"/rest/api/search?{qs}")
        results = data.get("results", [])
        if not results:
            total = 0
        else:
            proj_page_id = results[0]["content"]["id"]
            qs2 = urllib.parse.urlencode({
                "cql": f"ancestor={proj_page_id} AND type=page",
                "limit": 0,
            })
            data2 = _request_json(opener, f"/rest/api/search?{qs2}")
            total = data2.get("totalSize", 0)
        if args.raw:
            return emit_json({"total_projects": total})
        print(total)

    @staticmethod
    def list(opener: t.Any, args: t.Any) -> None:
        """List project pages."""
        Pages.list(opener, args)

    @staticmethod
    def read(opener: t.Any, args: t.Any) -> None:
        """Read a project page."""
        Pages.read(opener, args)

    @staticmethod
    def create(opener: t.Any, args: t.Any) -> None:
        """Create a project page with the Alexandra Way template."""
        body = _PROJECT_TEMPLATE.format(
            title=html.escape(args.title),
            client=html.escape(args.client),
            owner=html.escape(args.owner),
            budget=html.escape(args.budget),
        )
        payload: dict[str, t.Any] = {
            "type": "page",
            "title": args.title,
            "space": {"key": args.space_key},
            "body": {
                "storage": {
                    "value": body,
                    "representation": "storage",
                },
            },
            "ancestor": {
                "id": resolve_page_id(
                    opener, "Projektoverblik", space_key="PROJ"
                )
            },
        }

        data = _request_json(
            opener,
            "/rest/api/content",
            method="POST",
            body=payload,
        )
        if args.raw:
            return emit_json(data)

        print(f"Created project page: {data.get('title')}")
        print(f"  ID:       {data.get('id')}")
        print(
            f"  URL:      "
            f"{BASE}/pages/viewpage.action?pageId={data.get('id')}"
        )
        print("  Template: The Alexandra Way (projektforkl\u00e6de)")

    @staticmethod
    def update(opener: t.Any, args: t.Any) -> None:
        """Update a project page."""
        Pages.update(opener, args)
