#!/usr/bin/env python3

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path, PurePosixPath
from urllib.parse import unquote

SOURCE_ROOTS = {"src", "dist"}
BINARY_LINE = re.compile(r"^(?:GIT binary patch|literal(?:\s|$)|delta(?:\s|$))")


class PatchError(ValueError):
    pass


def load_json(path: Path):
    text = path.read_text(encoding="utf-8")
    output = []
    in_string = escaped = False
    for index, char in enumerate(text):
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        if char == ",":
            cursor = index + 1
            while cursor < len(text) and text[cursor].isspace():
                cursor += 1
            if cursor < len(text) and text[cursor] in "]}":
                continue
        output.append(char)
    return json.loads("".join(output))


def split_package_key(key: str) -> tuple[str, str]:
    package, separator, version = key.rpartition("@")
    if not separator or not package or not version:
        raise PatchError(f"invalid patched dependency key: {key}")
    return package, version


def source_path(raw: str, prefix: str | None = None, allow_null: bool = False) -> str:
    if allow_null and raw == "/dev/null":
        return raw
    if any(char.isspace() for char in raw) or raw.startswith(("/", "\\")):
        raise PatchError(f"invalid patch path: {raw}")
    if prefix:
        expected = f"{prefix}/"
        if not raw.startswith(expected):
            raise PatchError(f"patch path must start with {expected}: {raw}")
        raw = raw[len(expected) :]
    path = PurePosixPath(raw)
    if not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise PatchError(f"unsafe patch path: {raw}")
    if path.parts[0] not in SOURCE_ROOTS or len(path.parts) == 1:
        raise PatchError(f"patch path is outside src/ or dist/: {raw}")
    return path.as_posix()


def check_patch(path: Path) -> None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError as error:
        raise PatchError(f"{path}: patch is not UTF-8 text") from error

    current = None
    old_header_path = new_header_path = None
    hunk = False
    diff_count = 0

    def finish() -> None:
        if current is None:
            return
        if old_header_path is None or new_header_path is None or not hunk:
            raise PatchError(f"{path}: diff for {current[0]} lacks text headers or a hunk")
        if old_header_path == new_header_path == "/dev/null":
            raise PatchError(f"{path}: diff cannot use /dev/null for both file headers")
        if old_header_path != "/dev/null" and old_header_path != current[0]:
            raise PatchError(f"{path}: old-file path disagrees with diff header")
        if new_header_path != "/dev/null" and new_header_path != current[1]:
            raise PatchError(f"{path}: new-file path disagrees with diff header")

    for line in lines:
        if BINARY_LINE.match(line) or line.startswith("Binary files "):
            raise PatchError(f"{path}: binary patch content is forbidden: {line}")
        if line.startswith("diff --git "):
            finish()
            fields = line.split()
            if len(fields) != 4:
                raise PatchError(f"{path}: malformed diff header: {line}")
            old_path = source_path(fields[2], "a")
            new_path = source_path(fields[3], "b")
            current = (old_path, new_path)
            old_header_path = new_header_path = None
            hunk = False
            diff_count += 1
        elif not hunk and line.startswith("--- "):
            if current is None or old_header_path is not None:
                raise PatchError(f"{path}: misplaced old-file header")
            old_header_path = source_path(line[4:].split("\t", 1)[0], "a", allow_null=True)
        elif not hunk and line.startswith("+++ "):
            if current is None or old_header_path is None or new_header_path is not None:
                raise PatchError(f"{path}: misplaced new-file header")
            new_header_path = source_path(line[4:].split("\t", 1)[0], "b", allow_null=True)
        elif line.startswith("@@"):
            if current is None or old_header_path is None or new_header_path is None:
                raise PatchError(f"{path}: hunk appears before file headers")
            if not re.match(r"^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: |$)", line):
                raise PatchError(f"{path}: malformed hunk header: {line}")
            hunk = True
        elif line.startswith(("rename from ", "rename to ", "copy from ", "copy to ")):
            source_path(line.split(" ", 2)[2])

    finish()
    if not diff_count:
        raise PatchError(f"{path}: contains no diffs")


def validate(root: Path) -> int:
    manifest = load_json(root / "package.json")
    lockfile = load_json(root / "bun.lock")
    manifest_patches = manifest.get("patchedDependencies", {})
    lock_patches = lockfile.get("patchedDependencies", {})
    if not isinstance(manifest_patches, dict) or manifest_patches != lock_patches:
        raise PatchError("package.json and bun.lock patchedDependencies must match")

    patches_dir = root / "patches"
    files = sorted(path for path in patches_dir.rglob("*") if path.is_file()) if patches_dir.is_dir() else []
    if manifest_patches and not files:
        raise PatchError("patchedDependencies is non-empty but patches/ contains no files")
    non_patches = [path for path in files if path.suffix != ".patch"]
    if non_patches:
        raise PatchError(f"non-.patch file under patches/: {non_patches[0].relative_to(root)}")

    if not all(isinstance(value, str) for value in manifest_patches.values()):
        raise PatchError("patchedDependencies paths must be strings")
    actual_paths = {path.relative_to(root).as_posix() for path in files}
    expected_paths = set(manifest_patches.values())
    if len(expected_paths) != len(manifest_patches):
        raise PatchError("patchedDependencies contains duplicate patch paths")
    if actual_paths != expected_paths:
        raise PatchError("patches/ files and patchedDependencies paths must match exactly")

    packages = lockfile.get("packages", {})
    seen_keys = set()
    for path in files:
        key = unquote(path.stem)
        if key in seen_keys:
            raise PatchError(f"duplicate decoded patch key: {key}")
        seen_keys.add(key)
        relative = path.relative_to(root).as_posix()
        if manifest_patches.get(key) != relative:
            raise PatchError(f"{relative}: decoded key {key!r} is not mapped to this patch")
        package, pinned_version = split_package_key(key)
        resolved = packages.get(package)
        if not isinstance(resolved, list) or not resolved or not isinstance(resolved[0], str):
            raise PatchError(f"{relative}: {package} has no resolved bun.lock package")
        resolved_package, resolved_version = split_package_key(resolved[0])
        if resolved_package != package or resolved_version != pinned_version:
            raise PatchError(
                f"{relative}: pinned {pinned_version} does not match bun.lock {resolved[0]}"
            )
        check_patch(path)
    return len(files)


def selftest() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        patches = root / "patches"
        patches.mkdir()
        filename = "@scope%2Fpackage@1.2.3.patch"
        mapping = {"@scope/package@1.2.3": f"patches/{filename}"}
        (root / "package.json").write_text(json.dumps({"patchedDependencies": mapping}), encoding="utf-8")
        (root / "bun.lock").write_text(
            json.dumps({"patchedDependencies": mapping, "packages": {"@scope/package": ["@scope/package@1.2.3"]}}),
            encoding="utf-8",
        )
        patch = patches / filename
        patch.write_text(
            "diff --git a/src/added.txt b/src/added.txt\n"
            "--- /dev/null\n"
            "+++ b/src/added.txt\n"
            "@@ -0,0 +1 @@\n"
            "+added\n"
            "diff --git a/dist/deleted.txt b/dist/deleted.txt\n"
            "--- a/dist/deleted.txt\n"
            "+++ /dev/null\n"
            "@@ -1 +0,0 @@\n"
            "-deleted\n",
            encoding="utf-8",
        )
        validate(root)

        invalid_patches = (
            (
                "outside-root addition",
                "diff --git a/src/added.txt b/src/added.txt\n--- /dev/null\n+++ b/docs/added.txt\n@@ -0,0 +1 @@\n+added\n",
                "outside src/ or dist/",
            ),
            (
                "outside-root deletion",
                "diff --git a/src/deleted.txt b/src/deleted.txt\n--- a/docs/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted\n",
                "outside src/ or dist/",
            ),
            (
                "both-null diff",
                "diff --git a/src/file.txt b/src/file.txt\n--- /dev/null\n+++ /dev/null\n@@ -0,0 +0,0 @@\n",
                "/dev/null for both file headers",
            ),
        )
        for label, content, expected_error in invalid_patches:
            patch.write_text(content, encoding="utf-8")
            try:
                validate(root)
            except PatchError as error:
                if expected_error in str(error):
                    continue
                raise PatchError(f"selftest failed for {label}: {error}") from error
            raise PatchError(f"selftest failed: accepted {label}")

        patch.write_text(
            "diff --git a/src/image.png b/src/image.png\nGIT binary patch\nliteral 1\nA\n",
            encoding="utf-8",
        )
        try:
            validate(root)
        except PatchError as error:
            if "binary patch content" in str(error):
                return
            raise PatchError(f"selftest failed for wrong reason: {error}") from error
        raise PatchError("selftest failed: binary patch was accepted")


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate Bun dependency patches")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    try:
        if args.selftest:
            selftest()
            print("patch hygiene selftest passed")
        else:
            count = validate(Path(__file__).resolve().parent.parent)
            print(f"patch hygiene passed: {count} patch(es)")
    except (OSError, json.JSONDecodeError, PatchError) as error:
        print(f"patch hygiene failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
