#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(
    cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd
)
cd "$SCRIPT_DIR"

PACKAGE_JSON_FILE="${PACKAGE_JSON_FILE:-package.json}"
CHANGELOG_FILE="${CHANGELOG_FILE:-docs/changelog.md}"
TAG_PREFIX="${TAG_PREFIX:-v}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
BUILD_COMMAND="${BUILD_COMMAND:-npm run dist:mac}"
RELEASE_OUTPUT_DIR="${RELEASE_OUTPUT_DIR:-}"

DRY_RUN=0

usage() {
    cat <<'EOF'
Usage: ./publish.sh [--dry-run]

Stages and commits pending changes, pushes the current branch, builds the macOS
ARM64 DMG, creates and pushes an annotated git tag from package.json.version and
the first section in docs/changelog.md, then creates a GitHub release. If the
working tree is clean, the current HEAD is released without creating an empty
commit.

Options:
  --dry-run   Print the resolved commit, build, tag and release notes without writing anything
  -h, --help  Show this help

Environment:
  PACKAGE_JSON_FILE  Override package.json path
  CHANGELOG_FILE     Override changelog path, defaults to "docs/changelog.md"
  TAG_PREFIX         Tag prefix, defaults to "v"
  GIT_REMOTE         Git remote used with --push, defaults to "origin"
  BUILD_COMMAND      Release build command, defaults to "npm run dist:mac"
  RELEASE_OUTPUT_DIR Override release artifact directory, defaults to package.json build.directories.output
EOF
}

fail() {
    printf 'Error: %s\n' "$1" >&2
    exit 1
}

join_lines() {
    local item
    for item in "$@"; do
        printf '  - %s\n' "$item"
    done
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)
            DRY_RUN=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            fail "unknown argument: $1"
            ;;
    esac
    shift
done

[[ -f "$PACKAGE_JSON_FILE" ]] || fail "missing $PACKAGE_JSON_FILE"
[[ -f "$CHANGELOG_FILE" ]] || fail "missing $CHANGELOG_FILE"

git rev-parse --git-dir >/dev/null 2>&1 || fail "this is not a git repository"
git remote get-url "$GIT_REMOTE" >/dev/null 2>&1 || fail "git remote '$GIT_REMOTE' does not exist"
command -v gh >/dev/null 2>&1 || fail "gh CLI is required"
gh auth status -h github.com >/dev/null 2>&1 || fail "gh is not authenticated for github.com"

CURRENT_BRANCH=$(git symbolic-ref --quiet --short HEAD) || fail "publish requires a checked out branch"

[[ "$(uname -s)" == "Darwin" ]] || fail "publish supports macOS only"
[[ "$(uname -m)" == "arm64" ]] || fail "publish supports Apple Silicon only"

VERSION=$(
    node -e "const fs = require('fs'); const pkg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (!pkg.version) process.exit(1); process.stdout.write(pkg.version);" \
        "$PACKAGE_JSON_FILE"
) || fail "could not read version from $PACKAGE_JSON_FILE"

if [[ -z "$RELEASE_OUTPUT_DIR" ]]; then
    RELEASE_OUTPUT_DIR=$(
        node -e "const fs = require('fs'); const pkg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write((pkg.build && pkg.build.directories && pkg.build.directories.output) || 'dist');" \
            "$PACKAGE_JSON_FILE"
    ) || fail "could not read build output directory from $PACKAGE_JSON_FILE"
fi

CHANGELOG_TITLE=$(
    awk '
        /^#[[:space:]]+/ {
            line = $0
            sub(/^#[[:space:]]+/, "", line)
            print line
            exit
        }
    ' "$CHANGELOG_FILE"
) || true

[[ -n "${CHANGELOG_TITLE:-}" ]] || fail "could not find a top-level changelog section in $CHANGELOG_FILE"

if [[ "$CHANGELOG_TITLE" =~ ^[Vv]?([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
    CHANGELOG_VERSION="${BASH_REMATCH[1]}"
else
    fail "top changelog title must be a version heading like '# 0.5.0', got '$CHANGELOG_TITLE'"
fi

[[ "$VERSION" == "$CHANGELOG_VERSION" ]] || fail "package.json version ($VERSION) does not match top changelog title ($CHANGELOG_VERSION)"

CHANGELOG_BODY=$(
    awk '
        /^#[[:space:]]+/ {
            if (seen_heading) {
                exit
            }
            seen_heading = 1
            next
        }
        seen_heading {
            lines[++count] = $0
        }
        END {
            start = 1
            while (start <= count && lines[start] ~ /^[[:space:]]*$/) {
                start++
            }
            end = count
            while (end >= start && lines[end] ~ /^[[:space:]]*$/) {
                end--
            }
            for (i = start; i <= end; i++) {
                print lines[i]
            }
        }
    ' "$CHANGELOG_FILE"
)

TAG_NAME="${TAG_PREFIX}${VERSION}"
COMMIT_MESSAGE="publish ${TAG_NAME}"

git rev-parse --verify "refs/tags/$TAG_NAME" >/dev/null 2>&1 && fail "tag '$TAG_NAME' already exists"
gh release view "$TAG_NAME" >/dev/null 2>&1 && fail "GitHub release '$TAG_NAME' already exists"

TAG_MESSAGE_FILE=$(mktemp)
cleanup() {
    rm -f "$TAG_MESSAGE_FILE"
}
trap cleanup EXIT

{
    printf '%s\n' "$CHANGELOG_TITLE"
    if [[ -n "$CHANGELOG_BODY" ]]; then
        printf '\n%s\n' "$CHANGELOG_BODY"
    fi
} >"$TAG_MESSAGE_FILE"

collect_release_artifacts() {
    local output_dir="$1"
    local version="$2"
    local required="${3:-1}"
    local files=()
    local file

    if [[ ! -d "$output_dir" ]]; then
        if [[ "$required" -eq 1 ]]; then
            fail "release output directory '$output_dir' does not exist"
        fi
        return 0
    fi

    while IFS= read -r file; do
        files+=("$file")
    done < <(
        find "$output_dir" -maxdepth 1 -type f \
            -name "*${version}*-arm64.dmg" \
            | LC_ALL=C sort
    )

    if [[ "${#files[@]}" -eq 0 ]]; then
        if [[ "$required" -eq 1 ]]; then
            fail "no release artifacts found in '$output_dir' for version $version"
        fi
        return 0
    fi

    printf '%s\n' "${files[@]}"
}

if [[ "$DRY_RUN" -eq 1 ]]; then
    RELEASE_ARTIFACTS=()
    while IFS= read -r artifact; do
        RELEASE_ARTIFACTS+=("$artifact")
    done < <(collect_release_artifacts "$RELEASE_OUTPUT_DIR" "$VERSION" 0)
    printf 'Branch: %s\n' "$CURRENT_BRANCH"
    printf 'Commit message: %s\n\n' "$COMMIT_MESSAGE"
    printf 'Build command: %s\n\n' "$BUILD_COMMAND"
    printf 'Release output dir: %s\n' "$RELEASE_OUTPUT_DIR"
    printf 'Release artifacts:\n'
    if [[ "${#RELEASE_ARTIFACTS[@]}" -gt 0 ]]; then
        join_lines "${RELEASE_ARTIFACTS[@]}"
    else
        printf '  - resolved after build\n'
    fi
    printf '\n'
    printf 'Tag: %s\n\n' "$TAG_NAME"
    printf 'Release notes:\n'
    cat "$TAG_MESSAGE_FILE"
    exit 0
fi

printf 'Staging release changes\n'
git add -A
if git diff --cached --quiet; then
    printf 'No release changes to commit; releasing current HEAD\n'
else
    printf 'Creating commit: %s\n' "$COMMIT_MESSAGE"
    git commit -m "$COMMIT_MESSAGE"
fi

printf 'Pushing branch %s to %s\n' "$CURRENT_BRANCH" "$GIT_REMOTE"
git push "$GIT_REMOTE" "$CURRENT_BRANCH"

printf 'Running build: %s\n' "$BUILD_COMMAND"
sh -lc "$BUILD_COMMAND"
git diff --quiet || fail "build modified tracked files; commit those changes before tagging"
RELEASE_ARTIFACTS=()
while IFS= read -r artifact; do
    RELEASE_ARTIFACTS+=("$artifact")
done < <(collect_release_artifacts "$RELEASE_OUTPUT_DIR" "$VERSION")

git tag -a "$TAG_NAME" -F "$TAG_MESSAGE_FILE"
printf 'Created tag %s\n' "$TAG_NAME"

git push "$GIT_REMOTE" "$TAG_NAME"
printf 'Pushed %s to %s\n' "$TAG_NAME" "$GIT_REMOTE"

printf 'Creating GitHub release %s\n' "$TAG_NAME"
gh release create "$TAG_NAME" --verify-tag --title "$TAG_NAME" --notes-file "$TAG_MESSAGE_FILE"
printf 'Created GitHub release %s\n' "$TAG_NAME"

printf 'Uploading release artifacts\n'
join_lines "${RELEASE_ARTIFACTS[@]}"
gh release upload "$TAG_NAME" "${RELEASE_ARTIFACTS[@]}"
printf 'Uploaded release artifacts for %s\n' "$TAG_NAME"
