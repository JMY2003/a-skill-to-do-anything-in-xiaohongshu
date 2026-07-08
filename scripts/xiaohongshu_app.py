#!/usr/bin/env python3
"""Script-only macOS UI automation helpers for the Xiaohongshu app.

This script intentionally uses only stdlib + osascript so it can run from a
Codex skill without installing GUI automation packages. It automates app steps
through scripts, screenshots, keyboard input, and coordinates.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

BUNDLE_ID = "com.xingin.discover"
PROCESS_NAME = "discover"
DEFAULT_APP = "/Applications/\u5c0f\u7ea2\u4e66.app"


class XiaohongshuError(RuntimeError):
    pass


def run(args: list[str], *, input_text: str | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=check,
    )


def osa(script: str) -> str:
    proc = run(["/usr/bin/osascript"], input_text=script, check=False)
    if proc.returncode != 0:
        raise XiaohongshuError(proc.stderr.strip() or proc.stdout.strip() or "osascript failed")
    return proc.stdout.rstrip("\n")


def aq(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", '" & return & "') + '"'


def activate(wait: float = 0.8) -> None:
    script = f"""
try
  tell application id {aq(BUNDLE_ID)} to activate
on error
  do shell script {aq("open -a " + DEFAULT_APP)}
end try
delay {wait}
"""
    osa(script)


def ensure_process() -> None:
    activate()
    script = f"""
tell application "System Events"
  if not (exists process {aq(PROCESS_NAME)}) then error "Xiaohongshu process not found"
  tell process {aq(PROCESS_NAME)}
    set frontmost to true
  end tell
end tell
"""
    osa(script)


def screenshot(out: Path) -> None:
    ensure_process()
    out = out.expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    run(["/usr/sbin/screencapture", "-x", str(out)])
    print(out)


def current_input_source() -> str:
    proc = run(
        ["/usr/bin/defaults", "read", "com.apple.HIToolbox", "AppleCurrentKeyboardLayoutInputSourceID"],
        check=False,
    )
    return proc.stdout.strip() if proc.returncode == 0 else ""


def input_source(mode: str) -> None:
    if mode != "abc":
        raise XiaohongshuError("Only input-source abc is currently supported")
    for _ in range(4):
        if current_input_source() == "com.apple.keylayout.ABC":
            print("com.apple.keylayout.ABC")
            return
        osa(
            """
tell application "System Events"
  key code 49 using {control down}
end tell
"""
        )
        time.sleep(0.4)
    raise XiaohongshuError(f"Could not switch to ABC input source; current={current_input_source()}")


def paste_text(text: str, restore_clipboard: bool = True) -> None:
    old_clip = None
    if restore_clipboard:
        old = run(["/usr/bin/pbpaste"], check=False)
        if old.returncode == 0:
            old_clip = old.stdout
    run(["/usr/bin/pbcopy"], input_text=text)
    script = f"""
tell application "System Events"
  tell process {aq(PROCESS_NAME)}
    set frontmost to true
    keystroke "v" using command down
  end tell
end tell
"""
    osa(script)
    if old_clip is not None:
        run(["/usr/bin/pbcopy"], input_text=old_clip)


def type_ascii(text: str) -> None:
    try:
        text.encode("ascii")
    except UnicodeEncodeError as exc:
        raise XiaohongshuError("type-ascii only accepts ASCII text; use paste for non-ASCII") from exc
    input_source("abc")
    script_lines = [
        'tell application "System Events"',
        f"  tell process {aq(PROCESS_NAME)}",
        "    set frontmost to true",
    ]
    lines = text.split("\n")
    for idx, line in enumerate(lines):
        if line:
            script_lines.append(f"    keystroke {aq(line)}")
        if idx < len(lines) - 1:
            script_lines.append("    key code 36")
    script_lines.extend(["  end tell", "end tell"])
    osa("\n".join(script_lines))


def press(key: str, modifiers: list[str] | None = None) -> None:
    modifiers = modifiers or []
    if modifiers:
        mod_text = " using {" + ", ".join(m + " down" for m in modifiers) + "}"
    else:
        mod_text = ""
    script = f"""
tell application "System Events"
  tell process {aq(PROCESS_NAME)}
    set frontmost to true
    keystroke {aq(key)}{mod_text}
  end tell
end tell
"""
    osa(script)


def key_code(code: int) -> None:
    script = f"""
tell application "System Events"
  tell process {aq(PROCESS_NAME)}
    set frontmost to true
    key code {code}
  end tell
end tell
"""
    osa(script)


def dump_ui(max_depth: int = 6) -> str:
    script = f"""
on spaces(n)
  set s to ""
  repeat n times
    set s to s & "  "
  end repeat
  return s
end spaces

on safeS(e)
  set bits to {{}}
  try
    set end of bits to (role of e as text)
  end try
  try
    set end of bits to (name of e as text)
  end try
  try
    set end of bits to (description of e as text)
  end try
  try
    set end of bits to (value of e as text)
  end try
  set AppleScript's text item delimiters to " | "
  set outS to bits as text
  set AppleScript's text item delimiters to ""
  return outS
end safeS

on walk(e, depth, maxDepth)
  set outS to my spaces(depth) & my safeS(e) & linefeed
  if depth >= maxDepth then return outS
  try
    tell application "System Events" to set child_list to UI elements of e
    repeat with child in child_list
      set outS to outS & my walk(child, depth + 1, maxDepth)
    end repeat
  end try
  return outS
end walk

tell application "System Events"
  if not (exists process {aq(PROCESS_NAME)}) then error "Xiaohongshu process not found"
  tell process {aq(PROCESS_NAME)}
    set frontmost to true
    set targetWindow to window 1
    return my walk(targetWindow, 0, {max_depth})
  end tell
end tell
"""
    return osa(script)


def ui_contains(text: str, max_depth: int = 8) -> bool:
    script = f"""
on elementS(e)
  set outS to ""
  try
    set outS to outS & " " & (name of e as text)
  end try
  try
    set outS to outS & " " & (description of e as text)
  end try
  try
    set outS to outS & " " & (value of e as text)
  end try
  return outS
end elementS

on hasNeedle(e, needle, depth, maxDepth)
  set candidate to my elementS(e)
  if candidate contains needle then return true
  if depth >= maxDepth then return false
  try
    tell application "System Events" to set child_list to UI elements of e
    repeat with child in child_list
      set childHasNeedle to my hasNeedle(child, needle, depth + 1, maxDepth)
      if childHasNeedle then return true
    end repeat
  end try
  return false
end hasNeedle

tell application "System Events"
  if not (exists process {aq(PROCESS_NAME)}) then error "Xiaohongshu process not found"
  tell process {aq(PROCESS_NAME)}
    set frontmost to true
    set targetWindow to window 1
    if my hasNeedle(targetWindow, {aq(text)}, 0, {max_depth}) then
      return "true"
    else
      return "false"
    end if
  end tell
end tell
"""
    return osa(script).strip() == "true"


def click_text(text: str, *, exact: bool = False, max_depth: int = 8) -> None:
    exact_flag = "true" if exact else "false"
    script = f"""
on elementS(e)
  set bits to {{}}
  try
    set end of bits to (name of e as text)
  end try
  try
    set end of bits to (description of e as text)
  end try
  try
    set end of bits to (value of e as text)
  end try
  set AppleScript's text item delimiters to " "
  set outS to bits as text
  set AppleScript's text item delimiters to ""
  return outS
end elementS

on matches(e, needle, exactMatch)
  set t to my elementS(e)
  if exactMatch then
    return t is needle
  else
    return t contains needle
  end if
end matches

on findMatch(e, needle, exactMatch, depth, maxDepth)
  if my matches(e, needle, exactMatch) then return e
  if depth >= maxDepth then return missing value
  try
    tell application "System Events" to set child_list to UI elements of e
    repeat with child in child_list
      set found to my findMatch(child, needle, exactMatch, depth + 1, maxDepth)
      if found is not missing value then return found
    end repeat
  end try
  return missing value
end findMatch

on clickCenter(e)
  try
    click e
    return
  end try
  set p to position of e
  set s to size of e
  set cx to (item 1 of p) + ((item 1 of s) / 2)
  set cy to (item 2 of p) + ((item 2 of s) / 2)
  click at {{cx, cy}}
end clickCenter

tell application "System Events"
  if not (exists process {aq(PROCESS_NAME)}) then error "Xiaohongshu process not found"
  tell process {aq(PROCESS_NAME)}
    set frontmost to true
    set targetWindow to window 1
    set found to my findMatch(targetWindow, {aq(text)}, {exact_flag}, 0, {max_depth})
    if found is missing value then error "No visible UI element contains: {text}"
    my clickCenter(found)
  end tell
end tell
"""
    osa(script)


def click_coord(x: float, y: float) -> None:
    script = f"""
tell application "System Events"
  tell process {aq(PROCESS_NAME)}
    set frontmost to true
    click at {{{x}, {y}}}
  end tell
end tell
"""
    osa(script)


def click_window_fraction(x_fraction: float, y_fraction: float) -> None:
    script = f"""
tell application "System Events"
  tell process {aq(PROCESS_NAME)}
    set frontmost to true
    set p to position of window 1
    set s to size of window 1
    set x to (item 1 of p) + ((item 1 of s) * {x_fraction})
    set y to (item 2 of p) + ((item 2 of s) * {y_fraction})
    click at {{x, y}}
  end tell
end tell
"""
    osa(script)


def click_optional_location(
    *,
    x: float | None = None,
    y: float | None = None,
    fraction: str | None = None,
) -> bool:
    if x is not None and y is not None:
        click_coord(x, y)
        return True
    if fraction:
        try:
            fx_s, fy_s = fraction.split(",", 1)
            click_window_fraction(float(fx_s), float(fy_s))
            return True
        except ValueError as exc:
            raise XiaohongshuError("fraction must be formatted like 0.5,0.96") from exc
    return False


def click_first_available(labels: list[str]) -> str:
    last_error = None
    for label in labels:
        try:
            click_text(label)
            return label
        except XiaohongshuError as exc:
            last_error = exc
    raise XiaohongshuError(str(last_error) if last_error else "No labels provided")


def stage_message(
    recipient: str,
    message: str,
    *,
    send: bool = False,
    recipient_x: float | None = None,
    recipient_y: float | None = None,
    recipient_fraction: str | None = None,
    input_x: float | None = None,
    input_y: float | None = None,
    input_fraction: str | None = "0.08,0.965",
) -> None:
    ensure_process()
    if ui_contains(recipient, max_depth=8):
        click_text(recipient)
        time.sleep(0.8)
    elif click_optional_location(x=recipient_x, y=recipient_y, fraction=recipient_fraction):
        time.sleep(0.8)
    else:
        try:
            click_first_available(["消息", "Message", "Messages"])
            time.sleep(0.6)
            click_text(recipient)
            time.sleep(0.8)
        except XiaohongshuError as exc:
            raise XiaohongshuError(
                f"Recipient is not script-visible: {recipient}. "
                "Open the chat manually or pass --recipient-x/--recipient-y or --recipient-fraction."
            ) from exc
    click_optional_location(x=input_x, y=input_y, fraction=input_fraction)
    paste_text(message)
    if send:
        key_code(36)  # Return


def search(query: str, *, field_x: float | None = None, field_y: float | None = None, field_fraction: str | None = None) -> None:
    ensure_process()
    if not click_optional_location(x=field_x, y=field_y, fraction=field_fraction):
        click_first_available(["首页", "发现", "Home"])
        time.sleep(0.8)
        click_first_available(["搜索", "Search"])
        time.sleep(0.3)
    paste_text(query)
    key_code(36)


def stage_comment(
    message: str,
    *,
    submit: bool = False,
    field_x: float | None = None,
    field_y: float | None = None,
    field_fraction: str | None = None,
) -> None:
    ensure_process()
    if not click_optional_location(x=field_x, y=field_y, fraction=field_fraction):
        click_first_available(["说点什么", "添加评论", "评论", "comment", "Comment"])
    time.sleep(0.3)
    paste_text(message)
    if submit:
        key_code(36)


def toggle_action(
    action: str,
    *,
    x: float | None = None,
    y: float | None = None,
    fraction: str | None = None,
) -> None:
    ensure_process()
    if click_optional_location(x=x, y=y, fraction=fraction):
        return
    label_map = {
        "like": ["赞", "点赞", "喜欢", "Like"],
        "favorite": ["收藏", "Favorite", "Save"],
    }
    labels = label_map.get(action)
    if not labels:
        raise XiaohongshuError(f"Unknown toggle action: {action}")
    click_first_available(labels)


def open_publisher() -> None:
    ensure_process()
    try:
        click_first_available(["发布", "创作", "Post", "Create"])
    except XiaohongshuError:
        click_window_fraction(0.5, 0.965)


def load_package(package_path: Path) -> dict:
    data = json.loads(package_path.read_text(encoding="utf-8"))
    for key in ["title", "body"]:
        if not data.get(key):
            raise XiaohongshuError(f"Package missing required field: {key}")
    data.setdefault("hashtags", [])
    data.setdefault("images", [])
    return data


def stage_post(
    package_path: Path,
    *,
    publish: bool = False,
    text_fraction: str | None = None,
    publish_fraction: str | None = None,
) -> None:
    data = load_package(package_path)
    open_publisher()
    print("Publisher opened. Use screenshot/click commands for image upload if needed.")
    print("Images:")
    for image in data["images"]:
        print(f"- {image}")
    body = data["body"].strip()
    hashtags = " ".join("#" + tag.lstrip("#") for tag in data["hashtags"])
    text = data["title"].strip() + "\n\n" + body
    if hashtags:
        text += "\n\n" + hashtags
    click_optional_location(fraction=text_fraction)
    paste_text(text)
    if publish:
        if not click_optional_location(fraction=publish_fraction):
            click_first_available(["发布", "Post", "Publish"])


def main() -> int:
    parser = argparse.ArgumentParser(description="Script-only Xiaohongshu local app automation.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("open", help="Open and activate the Xiaohongshu app.")

    shot = sub.add_parser("screenshot", help="Capture the current screen after focusing Xiaohongshu.")
    shot.add_argument("--out", required=True, type=Path)

    src = sub.add_parser("input-source", help="Switch keyboard input source.")
    src.add_argument("mode", choices=["abc"])

    dump = sub.add_parser("dump-ui", help="Print visible accessibility UI text.")
    dump.add_argument("--depth", type=int, default=6)

    contains = sub.add_parser("contains", help="Exit 0 if visible UI contains text.")
    contains.add_argument("text")
    contains.add_argument("--depth", type=int, default=8)

    click = sub.add_parser("click-text", help="Click a visible UI element containing text.")
    click.add_argument("text")
    click.add_argument("--exact", action="store_true")
    click.add_argument("--depth", type=int, default=8)

    coord = sub.add_parser("click-coord", help="Click absolute screen coordinates.")
    coord.add_argument("x", type=float)
    coord.add_argument("y", type=float)

    fraction = sub.add_parser("click-window-fraction", help="Click a position relative to the Xiaohongshu window.")
    fraction.add_argument("x_fraction", type=float)
    fraction.add_argument("y_fraction", type=float)

    paste = sub.add_parser("paste", help="Paste text into the focused Xiaohongshu field.")
    paste.add_argument("text")
    paste.add_argument("--keep-clipboard", action="store_true")

    typ = sub.add_parser("type-ascii", help="Type ASCII text into the focused Xiaohongshu field.")
    typ.add_argument("text")

    key = sub.add_parser("press", help="Press a key or Return.")
    key.add_argument("key", help="Text key, or RETURN.")
    key.add_argument("--modifier", action="append", default=[])

    msg = sub.add_parser("stage-message", help="Open a visible chat recipient and stage a message.")
    msg.add_argument("--recipient", required=True)
    msg.add_argument("--message", required=True)
    msg.add_argument("--send", action="store_true", help="Actually press Return after staging.")
    msg.add_argument("--recipient-x", type=float)
    msg.add_argument("--recipient-y", type=float)
    msg.add_argument("--recipient-fraction", help="Click recipient at window fraction x,y before typing.")
    msg.add_argument("--input-x", type=float)
    msg.add_argument("--input-y", type=float)
    msg.add_argument("--input-fraction", default="0.08,0.965", help="Click message input at window fraction x,y.")

    srch = sub.add_parser("search", help="Try to open search and submit a query.")
    srch.add_argument("query")
    srch.add_argument("--field-x", type=float)
    srch.add_argument("--field-y", type=float)
    srch.add_argument("--field-fraction", help="Click search field at window fraction x,y.")

    comment = sub.add_parser("stage-comment", help="Stage a comment in the current note.")
    comment.add_argument("message")
    comment.add_argument("--submit", action="store_true")
    comment.add_argument("--field-x", type=float)
    comment.add_argument("--field-y", type=float)
    comment.add_argument("--field-fraction", help="Click comment field at window fraction x,y.")

    toggle = sub.add_parser("toggle", help="Toggle the current note's like or favorite button.")
    toggle.add_argument("action", choices=["like", "favorite"])
    toggle.add_argument("--x", type=float)
    toggle.add_argument("--y", type=float)
    toggle.add_argument("--fraction", help="Click the button at window fraction x,y.")

    sub.add_parser("open-publisher", help="Open the publish/create flow.")

    post = sub.add_parser("stage-post", help="Stage a prepared Xiaohongshu post package.")
    post.add_argument("package", type=Path)
    post.add_argument("--publish", action="store_true")
    post.add_argument("--text-fraction", help="Click text field at window fraction x,y before pasting.")
    post.add_argument("--publish-fraction", help="Click publish button at window fraction x,y.")

    args = parser.parse_args()
    try:
        if args.cmd == "open":
            ensure_process()
        elif args.cmd == "screenshot":
            screenshot(args.out)
        elif args.cmd == "input-source":
            input_source(args.mode)
        elif args.cmd == "dump-ui":
            ensure_process()
            print(dump_ui(args.depth))
        elif args.cmd == "contains":
            ensure_process()
            return 0 if ui_contains(args.text, max_depth=args.depth) else 1
        elif args.cmd == "click-text":
            ensure_process()
            click_text(args.text, exact=args.exact, max_depth=args.depth)
        elif args.cmd == "click-coord":
            ensure_process()
            click_coord(args.x, args.y)
        elif args.cmd == "click-window-fraction":
            ensure_process()
            click_window_fraction(args.x_fraction, args.y_fraction)
        elif args.cmd == "paste":
            ensure_process()
            paste_text(args.text, restore_clipboard=not args.keep_clipboard)
        elif args.cmd == "type-ascii":
            ensure_process()
            type_ascii(args.text)
        elif args.cmd == "press":
            ensure_process()
            if args.key.upper() == "RETURN":
                key_code(36)
            else:
                press(args.key, args.modifier)
        elif args.cmd == "stage-message":
            stage_message(
                args.recipient,
                args.message,
                send=args.send,
                recipient_x=args.recipient_x,
                recipient_y=args.recipient_y,
                recipient_fraction=args.recipient_fraction,
                input_x=args.input_x,
                input_y=args.input_y,
                input_fraction=args.input_fraction,
            )
        elif args.cmd == "search":
            search(args.query, field_x=args.field_x, field_y=args.field_y, field_fraction=args.field_fraction)
        elif args.cmd == "stage-comment":
            stage_comment(
                args.message,
                submit=args.submit,
                field_x=args.field_x,
                field_y=args.field_y,
                field_fraction=args.field_fraction,
            )
        elif args.cmd == "toggle":
            toggle_action(args.action, x=args.x, y=args.y, fraction=args.fraction)
        elif args.cmd == "open-publisher":
            open_publisher()
        elif args.cmd == "stage-post":
            stage_post(
                args.package,
                publish=args.publish,
                text_fraction=args.text_fraction,
                publish_fraction=args.publish_fraction,
            )
        return 0
    except XiaohongshuError as exc:
        print(f"xiaohongshu_app.py: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
