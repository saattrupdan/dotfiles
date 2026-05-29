#!/usr/bin/env python3
"""Thin CLI for the public read APIs behind https://www.retsinformation.dk/.

Wraps the verified anonymous endpoints:
  - /api/extremesearch/GetLawRegisters    law register tree
  - /api/extremesearch/GetFobTags         subject/tag tree
  - /api/extremesearch/getcasehistorystatus case statuses
  - /api/documentClassificationfilter     document type filter
  - /api/lawregistry                      law registry (A-Z)
  - /api/ressort                          ministries
  - /api/ressort/fob                      FOB ressorts
  - /api/eli/routing-data                 ELI URL routing
  - /api/eli/named-authority-lists        ELI authority values
  - /api/eli/documentation/uri-templates  ELI URI templates
  - /api/eli/documentation/metadata-types ELI metadata types
  - /api/document/{id}                    document details
  - /api/document/metadata/{id}           document metadata
  - /api/document/{id}/timeline           document timeline
  - /api/maintenance/messages             maintenance notices
  - /sitemap.xml                          URL enumeration

Standard library only. See ./SKILL.md for the underlying spec.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import typing as t
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://www.retsinformation.dk"
UA = "Mozilla/5.0 (retsinformation-dk-api-cli)"


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    def _add(name: str, **kwargs: t.Any) -> argparse.ArgumentParser:
        p = sub.add_parser(name, **kwargs)
        p.add_argument(
            "--raw",
            action="store_true",
            help="print raw JSON/XML response",
        )
        return p

    p = _add(
        "law-registers",
        help="law register tree (filter by ministry/topic)",
    )
    p.set_defaults(func=cmd_law_registers)

    p = _add(
        "fob-tags",
        help="subject/tag tree for filtering results",
    )
    p.set_defaults(func=cmd_fob_tags)

    p = _add(
        "case-statuses",
        help="parliamentary case statuses (Afvist, Vedtaget, ...)",
    )
    p.set_defaults(func=cmd_case_statuses)

    p = _add(
        "doc-types",
        help="document type filter (Regler, Afgørelser)",
    )
    p.set_defaults(func=cmd_doc_types)

    p = _add(
        "law-registry",
        help="law registry (A-Z index)",
    )
    p.add_argument(
        "--filter",
        help="filter labels by substring",
    )
    p.add_argument(
        "--sort",
        action="store_true",
        help="sort output alphabetically",
    )
    p.add_argument(
        "--limit",
        type=int,
        help="max entries to print",
    )
    p.set_defaults(func=cmd_law_registry)

    p = _add(
        "ressort",
        help="list of Danish ministries",
    )
    p.set_defaults(func=cmd_ressort)

    p = _add(
        "fob-ressort",
        help="ministries under Parliamentary Ombudsman",
    )
    p.set_defaults(func=cmd_fob_ressort)

    p = _add(
        "eli-routing",
        help="ELI URL routing table (param key -> documentTypeId)",
    )
    p.set_defaults(func=cmd_eli_routing)

    p = _add(
        "authority-lists",
        help="ELI authority values (passed_by, type_document, ...)",
    )
    p.add_argument(
        "authority",
        nargs="?",
        help=(
            "specific authority to show (e.g. passed_by, type_document, relevant_for)"
        ),
    )
    p.set_defaults(func=cmd_authority_lists)

    p = _add(
        "uri-templates",
        help="ELI URI template definitions",
    )
    p.set_defaults(func=cmd_uri_templates)

    p = _add(
        "metadata-types",
        help="ELI ontology metadata property definitions",
    )
    p.set_defaults(func=cmd_metadata_types)

    p = _add(
        "document",
        help="fetch document by ELI path or numeric ID",
    )
    p.add_argument(
        "id",
        help=(
            "ELI path (e.g. eli/lta/2026/480, "
            "eli/accn/A20240001) for document "
            "details; numeric internal ID for "
            "--timeline / --metadata"
        ),
    )
    p.add_argument(
        "--timeline",
        action="store_true",
        help="fetch document timeline/history (requires numeric internal ID)",
    )
    p.add_argument(
        "--metadata",
        action="store_true",
        help="fetch document metadata (requires numeric internal ID)",
    )
    p.set_defaults(func=cmd_document)

    p = _add(
        "maintenance",
        help="check for active maintenance messages",
    )
    p.set_defaults(func=cmd_maintenance)

    p = _add(
        "sitemap",
        help="enumerate URLs from sitemap.xml",
    )
    p.add_argument(
        "--filter",
        help="filter URLs by substring",
    )
    p.add_argument(
        "--limit",
        type=int,
        help="max URLs to print",
    )
    p.set_defaults(func=cmd_sitemap)

    args = parser.parse_args()
    args.func(args)


def _request(
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = 30.0,
) -> tuple[int, bytes]:
    h: dict[str, str] = {
        "User-Agent": UA,
        "Accept": "application/json",
    }
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, method=method, headers=h, data=body)
    try:
        with urllib.request.urlopen(
            req,
            timeout=timeout,
        ) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        body_text = e.read() if e.fp else b""
        sys.stderr.write(f"HTTP {e.code} {e.reason} on {url}\n")
        if body_text:
            sys.stderr.write(
                body_text.decode("utf-8", errors="replace").rstrip() + "\n"
            )
        sys.exit(2)


def _emit(obj: t.Any) -> None:
    if isinstance(obj, (dict, list)):
        print(json.dumps(obj, ensure_ascii=False, indent=2))
    else:
        print(obj)


def _emit_raw(text: bytes) -> None:
    sys.stdout.buffer.write(text)
    sys.stdout.buffer.flush()


def cmd_law_registers(
    args: argparse.Namespace,
) -> None:
    _, raw = _request(f"{BASE}/api/extremesearch/GetLawRegisters")
    _emit(json.loads(raw.decode("utf-8", errors="replace")))


def cmd_fob_tags(args: argparse.Namespace) -> None:
    _, raw = _request(f"{BASE}/api/extremesearch/GetFobTags")
    _emit(json.loads(raw.decode("utf-8", errors="replace")))


def cmd_case_statuses(
    args: argparse.Namespace,
) -> None:
    _, raw = _request(f"{BASE}/api/extremesearch/getcasehistorystatus")
    _emit(json.loads(raw.decode("utf-8", errors="replace")))


def cmd_doc_types(args: argparse.Namespace) -> None:
    _, raw = _request(f"{BASE}/api/documentClassificationfilter")
    _emit(json.loads(raw.decode("utf-8", errors="replace")))


def cmd_law_registry(args: argparse.Namespace) -> None:
    _, raw = _request(f"{BASE}/api/lawregistry")
    data = json.loads(raw.decode("utf-8", errors="replace"))
    if args.sort:
        data = sorted(
            data,
            key=lambda x: x.get("label", ""),
        )
    if args.filter:
        data = [x for x in data if args.filter.lower() in x.get("label", "").lower()]
    if args.limit:
        data = data[: args.limit]
    if not args.raw:
        for item in data:
            print(
                f"{item.get('key', '')}\t{item.get('id', '')}\t{item.get('label', '')}"
            )
        return
    _emit(data)


def cmd_ressort(args: argparse.Namespace) -> None:
    _, raw = _request(f"{BASE}/api/ressort")
    _emit(json.loads(raw.decode("utf-8", errors="replace")))


def cmd_fob_ressort(args: argparse.Namespace) -> None:
    _, raw = _request(f"{BASE}/api/ressort/fob")
    _emit(json.loads(raw.decode("utf-8", errors="replace")))


def cmd_eli_routing(args: argparse.Namespace) -> None:
    _, raw = _request(f"{BASE}/api/eli/routing-data")
    data = json.loads(raw.decode("utf-8", errors="replace"))
    if args.raw:
        _emit(data)
        return
    doc_map = data.get("docTypeUrlParameterMap", {})
    for key, entries in doc_map.items():
        if not key:
            continue
        for e in entries:
            print(f"  {e['documentTypeId']:>5d}  {key}  {e['urlParamKeys']}")
    pub_map = data.get("publicationMediaUrlParameterMap", {})
    if pub_map:
        print("\n[publicationMediaUrlParameterMap]")
        for key, val in pub_map.items():
            print(f"  {val:>3d}  {key}")


def cmd_authority_lists(
    args: argparse.Namespace,
) -> None:
    _, raw = _request(f"{BASE}/api/eli/named-authority-lists")
    data = json.loads(raw.decode("utf-8", errors="replace"))
    if args.authority:
        if args.authority not in data:
            sys.stderr.write(
                f"Authority {args.authority!r} "
                f"not found. Known: "
                f"{sorted(data.keys())}\n"
            )
            sys.exit(2)
        _emit(data[args.authority])
    else:
        if args.raw:
            _emit(data)
        else:
            for key in sorted(data.keys()):
                val = data[key]
                codes = [v["authorityCode"] for v in val.get("values", [])]
                suffix = "..." if len(codes) > 10 else ""
                print(
                    f"{key:25s}  "
                    f"{len(codes):>3d} values: "
                    f"{', '.join(codes[:10])}"
                    f"{suffix}"
                )


def cmd_uri_templates(
    args: argparse.Namespace,
) -> None:
    _, raw = _request(f"{BASE}/api/eli/documentation/uri-templates")
    _emit(json.loads(raw.decode("utf-8", errors="replace")))


def cmd_metadata_types(
    args: argparse.Namespace,
) -> None:
    _, raw = _request(f"{BASE}/api/eli/documentation/metadata-types")
    _emit(json.loads(raw.decode("utf-8", errors="replace")))


def cmd_document(args: argparse.Namespace) -> None:
    doc_id = args.id
    if args.timeline:
        # GET /api/document/{numeric_id}/timeline
        _, raw = _request(f"{BASE}/api/document/{doc_id}/timeline")
        _emit(json.loads(raw.decode("utf-8", errors="replace")))
    elif args.metadata:
        # GET /api/document/metadata/{numeric_id}
        _, raw = _request(f"{BASE}/api/document/metadata/{doc_id}")
        _emit(json.loads(raw.decode("utf-8", errors="replace")))
    else:
        # POST /api/document/{eli_path} with JSON body
        body = json.dumps(
            {"isRawHtml": False},
        ).encode("utf-8")
        _, raw = _request(
            f"{BASE}/api/document/{doc_id}",
            method="POST",
            headers={
                "Content-Type": "application/json",
            },
            body=body,
        )
        _emit(json.loads(raw.decode("utf-8", errors="replace")))


def cmd_maintenance(args: argparse.Namespace) -> None:
    _, raw = _request(f"{BASE}/api/maintenance/messages")
    data = json.loads(raw.decode("utf-8", errors="replace"))
    if data:
        _emit(data)
    else:
        print("(no maintenance messages)")


def cmd_sitemap(args: argparse.Namespace) -> None:
    _, raw = _request(
        f"{BASE}/sitemap.xml",
        headers={"Accept": "*/*"},
        timeout=60,
    )
    xml = raw.decode("utf-8", errors="replace")
    if args.raw:
        _emit_raw(raw)
        return
    locs = re.findall(r"<loc>([^<]+)</loc>", xml)
    if args.filter:
        locs = [u for u in locs if args.filter.lower() in u.lower()]
    if args.limit:
        locs = locs[: args.limit]
    if not locs:
        sys.stderr.write("No <loc> entries found\n")
        sys.exit(2)
    for url in locs:
        print(url)


if __name__ == "__main__":
    main()
