"""Manage Atlas-backed app accounts through the Render admin API."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


def main() -> int:
    parser = argparse.ArgumentParser(description="Lecture Memo 계정 관리")
    parser.add_argument("action", choices=["create", "list", "disable", "enable", "rotate", "import-hash"])
    parser.add_argument("user_id", nargs="?")
    parser.add_argument("--server", default="https://web-audio-summary.onrender.com")
    args = parser.parse_args()
    if args.action != "list" and not args.user_id:
        parser.error("사용자 ID가 필요합니다.")
    if args.action == "list" and args.user_id:
        parser.error("list에는 사용자 ID를 입력하지 않습니다.")
    if not args.server.startswith("https://") and not args.server.startswith("http://localhost:") and not args.server.startswith("http://127.0.0.1:"):
        parser.error("서버 주소는 HTTPS여야 합니다.")

    admin_token = os.getenv("ADMIN_ACCESS_TOKEN") or getpass.getpass("관리자 비밀값: ")
    if not admin_token:
        parser.error("관리자 비밀값이 필요합니다.")
    path = "/v1/admin/users"
    if args.action == "import-hash":
        path += "/import"
    elif args.action != "list" and args.action != "create":
        path += f"/{quote(args.user_id, safe='')}/{args.action}"
    if args.action == "create":
        body = json.dumps({"user_id": args.user_id}).encode()
    elif args.action == "import-hash":
        token_hash = getpass.getpass("기존 접속 코드 SHA-256 해시: ")
        body = json.dumps({"user_id": args.user_id, "token_sha256": token_hash}).encode()
    else:
        body = None
    request = Request(
        args.server.rstrip("/") + path,
        data=body,
        method="GET" if args.action == "list" else "POST",
        headers={"X-Admin-Token": admin_token, "Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=45) as response:
            result = json.load(response)
    except HTTPError as exc:
        try:
            message = json.load(exc).get("error", {}).get("message", "요청에 실패했습니다.")
        except (ValueError, AttributeError):
            message = "요청에 실패했습니다."
        print(f"오류 {exc.code}: {message}", file=sys.stderr)
        return 1
    except URLError as exc:
        print(f"연결 오류: {exc.reason}", file=sys.stderr)
        return 1
    if args.action in {"create", "rotate"}:
        print(f"사용자 ID: {result['user_id']}\n접속 코드: {result['access_code']}")
        print("접속 코드는 다시 조회할 수 없습니다. 안전하게 전달해 주세요.")
    elif args.action == "list":
        for row in result["users"]:
            print(f"{row['user_id']}\t{row['status']}")
    else:
        print(f"{result['user_id']}: {result['status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
