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
WORKSPACE = REPO.parents[1]
REAL_INDEX = WORKSPACE / "浏览器插件相关" / "academic-clipper" / "papers" / "s41586-026-10401-1" / "index.md"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", action="store_true", help="disable the new viewport parse pass to prove the regression")
    parser.add_argument("--synthetic", action="store_true", help="force the deterministic realistic fixture")
    parser.add_argument("--full", action="store_true", help="print every visible range and rebuild event")
    parser.add_argument("--benchmark", action="store_true", help="record real-browser open/scroll timings for 1k/5k/10k/20k lines")
    args = parser.parse_args()
    source_path = None if args.synthetic or args.benchmark or not REAL_INDEX.is_file() else REAL_INDEX.relative_to(WORKSPACE).as_posix()

    handler = functools.partial(QuietHandler, directory=str(WORKSPACE))
    with socketserver.TCPServer(("127.0.0.1", 0), handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        query = ""
        base_url = f"http://127.0.0.1:{server.server_address[1]}/Quarto插件相关/md-live-preview-editor/scripts/long-document-browser-harness.html"
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            runs = [1000, 5000, 10000, 20000] if args.benchmark else [None]
            all_results = []
            for benchmark_lines in runs:
                page = browser.new_page(viewport={"width": 1280, "height": 800})
                page_errors = []
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                current_query = query
                if benchmark_lines is not None:
                    current_query += "&lines=" + str(benchmark_lines)
                elif source_path:
                    current_query += "&source=" + quote(source_path, safe="/")
                if args.baseline:
                    current_query += "&baseline=1"
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
                keys = ("docLength", "docLines", "viewport", "contentHeight", "scrollTop", "scrollHeight", "clientHeight", "syntaxTreeLength", "syntaxTreeAvailableToViewport", "syntaxTreeAvailableToDocument", "syntaxParserRunning", "decorationRebuildCount")
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
                printable = [compact_result(item) for item in all_results] if args.benchmark else compact_result(all_results[0])
            print(json.dumps(printable, ensure_ascii=False, indent=2))
            browser.close()
        server.shutdown()
    return 0 if all(item.get("ok") for item in all_results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
