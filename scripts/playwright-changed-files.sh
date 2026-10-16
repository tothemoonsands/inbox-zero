#!/usr/bin/env bash
set -euo pipefail

changed_files_path="$RUNNER_TEMP/changed-files.txt"
changed_test_files_path="$RUNNER_TEMP/changed-playwright-files.txt"
: > "$changed_files_path"
: > "$changed_test_files_path"

if [[ "$GITHUB_EVENT_NAME" == "pull_request" || "$GITHUB_EVENT_NAME" == "push" ]] &&
  [[ -n "$BASE_SHA" ]] &&
  [[ "$BASE_SHA" != "0000000000000000000000000000000000000000" ]]; then
  git fetch --no-tags --depth=1 origin "$BASE_SHA"
  git diff --name-only --diff-filter=ACMRD "$BASE_SHA" "$GITHUB_SHA" \
    > "$changed_files_path"
  grep '^apps/web/__tests__/playwright/' "$changed_files_path" | \
    sed 's#^apps/web/##' > "$changed_test_files_path" || true
fi

delimiter="PLAYWRIGHT_FILES_$(openssl rand -hex 16)"
{
  echo "PLAYWRIGHT_CHANGED_FILES<<$delimiter"
  cat "$changed_files_path"
  echo "$delimiter"
  echo "PLAYWRIGHT_CHANGED_TEST_FILES<<$delimiter"
  cat "$changed_test_files_path"
  echo "$delimiter"
} | tee -a "$GITHUB_ENV" >> "$GITHUB_OUTPUT"
