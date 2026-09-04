"""Run the real EditorView long-document regression in Chromium."""

from __future__ import annotations

import argparse
import functools
import http.server
import json
import socketserver
import threading
import time
from pathlib import Path
from urllib.parse import quote

from playwright.sync_api import sync_playwright


REPO = Path(__file__).resolve().parents[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", action="store_true", help="disable the new viewport parse pass to prove the regression")
    parser.add_argument("--synthetic", action="store_true", help="force the deterministic realistic fixture")
    parser.add_argument("--full", action="store_true", help="print every visible range and rebuild event")
    parser.add_argument("--benchmark", action="store_true", help="record real-browser open/scroll timings for 1k/5k/10k/20k lines")
    parser.add_argument("--source", help="optional repository-relative Markdown/Quarto fixture; default is deterministic synthetic content")
    parser.add_argument("--theme", help="optional bundled CSS theme filename to apply in the real EditorView")
    parser.add_argument("--bundle", help="load a bundle path relative to the served workspace (for regression comparison)")
    parser.add_argument("--probe", action="store_true", help="run the minimal multiline-display-math EditorView probe")
    args = parser.parse_args()
    source_path = None
    if args.source and not args.synthetic and not args.benchmark:
        candidate = (REPO / args.source).resolve()
        if not candidate.is_file() or REPO not in candidate.parents:
            parser.error("--source must name an existing file inside this repository")
        source_path = candidate.relative_to(REPO).as_posix()

    handler = functools.partial(QuietHandler, directory=str(REPO))
    with socketserver.TCPServer(("127.0.0.1", 0), handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        query = ""
        base_url = f"http://127.0.0.1:{server.server_address[1]}/scripts/long-document-browser-harness.html"
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            runs = [1000, 5000, 10000, 20000] if args.benchmark else [None]
            all_results = []
            for benchmark_lines in runs:
                page = browser.new_page(viewport={"width": 1280, "height": 800})
                page_errors = []
                if args.probe:
                    page.on("console", lambda message: print(f"[browser:{message.type}] {message.text}"))
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                current_query = query
                if benchmark_lines is not None:
                    current_query += "&lines=" + str(benchmark_lines)
                elif source_path:
                    current_query += "&source=" + quote(source_path, safe="/")
                if args.bundle:
                    current_query += "&bundle=" + quote(args.bundle, safe="/")
                if args.theme:
                    current_query += "&theme=" + quote(args.theme, safe="")
                if args.baseline:
                    current_query += "&baseline=1"
                if args.probe:
                    current_query += "&probe=1"
                url = f"{base_url}?{current_query.lstrip('&')}"
                started = time.perf_counter()
                page.goto(url, wait_until="load")
                page.wait_for_function("window.__mlpLongDocumentResult !== undefined", timeout=30000)
                result = page.evaluate("window.__mlpLongDocumentResult")
                result["browserElapsedMs"] = round((time.perf_counter() - started) * 1000, 1)
                result["pageErrors"] = page_errors
                if page_errors:
                    result["ok"] = False
                all_results.append(result)
                page.close()
            if args.full:
                printable = all_results if args.benchmark else all_results[0]
            else:
                keys = ("docLength", "docLines", "viewport", "contentHeight", "scrollTop", "scrollHeight", "clientHeight", "domLineCount", "syntaxTreeLength", "syntaxTreeAvailableToViewport", "syntaxTreeAvailableToDocument", "syntaxParserRunning", "decorationRebuildCount")
                compact_snapshot = lambda snapshot: {key: snapshot.get(key) for key in keys} if snapshot else None
                def compact_result(item):
                    return {
                        "ok": item.get("ok"), "baseline": item.get("baseline"), "sourceKind": item.get("sourceKind"),
                        "sourceLength": item.get("sourceLength"), "sourceLines": item.get("sourceLines"), "browserElapsedMs": item.get("browserElapsedMs"),
                        "initial": compact_snapshot(item.get("initial")),
                        "samples": [{"label": sample.get("label"), "parserCaughtUp": sample.get("parserCaughtUp"), "snapshot": compact_snapshot(sample.get("snapshot"))} for sample in item.get("samples", [])],
                        "eof": {"parserCaughtUp": item.get("eof", {}).get("parserCaughtUp"), "snapshot": compact_snapshot(item.get("eof", {}).get("snapshot"))},
                        "markers": [{key: marker.get(key) for key in ("label", "found", "pos", "viewportContains", "domContainsMarker")} for marker in item.get("markers", [])],
                        "final": compact_snapshot(item.get("final")), "markerFailures": item.get("markerFailures"), "pageErrors": item.get("pageErrors"), "error": item.get("error"),
                    }
                if args.benchmark:
                    printable = {
                        "ok": all(item.get("ok") for item in all_results),
                        "runs": [
                            {
                                "sourceKind": item.get("sourceKind"),
                                "lines": item.get("sourceLines"),
                                "characters": item.get("sourceLength"),
                                "readyMs": item.get("readyMs"),
                                "scrollMs": [sample.get("elapsedMs") for sample in item.get("samples", [])],
                                "eofMs": item.get("eof", {}).get("elapsedMs"),
                                "parserCaughtUp": [sample.get("parserCaughtUp") for sample in item.get("samples", [])] + [item.get("eof", {}).get("parserCaughtUp")],
                                "domLineCounts": [sample.get("snapshot", {}).get("domLineCount") for sample in item.get("samples", [])],
                                "maxDecorationRebuilds": max(
                                    [sample.get("snapshot", {}).get("decorationRebuildCount", 0) for sample in item.get("samples", [])]
                                    + [item.get("eof", {}).get("snapshot", {}).get("decorationRebuildCount", 0)]
                                ),
                                "longTaskCount": item.get("longTaskCount", 0),
                                "longTaskTotalMs": item.get("longTaskTotalMs", 0),
                                "pageErrors": item.get("pageErrors", []),
                            }
                            for item in all_results
                        ],
                    }
                else:
                    printable = compact_result(all_results[0])
            print(json.dumps(printable, ensure_ascii=False, indent=2))
            browser.close()
        server.shutdown()
    return 0 if all(item.get("ok") for item in all_results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
