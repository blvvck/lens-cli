#!/usr/bin/env bash
cd "$(dirname "${BASH_SOURCE[0]}")/.."
passed=0
failed=0
record() {
  local label="$1"
  local result="$2"
  if [[ "$result" != ok ]]; then
    printf 'FAIL: %s\n' "$label"
    ((failed += 1))
    return
  fi
  printf 'PASS: %s\n' "$label"
  ((passed += 1))
}
contains_text() {
  local label="$1" invocation="$2" fragment="$3" captured
  captured=$(eval "$invocation" 2>&1) || true
  if grep -Fq -- "$fragment" <<< "$captured"; then record "$label" ok; return; fi
  printf '  command: %s\n  expected text: %s\n  received: %s\n' "$invocation" "$fragment" "$captured"
  record "$label" fail
}
omits_text() {
  local label="$1" invocation="$2" fragment="$3" captured
  captured=$(eval "$invocation" 2>&1) || true
  if grep -Fq -- "$fragment" <<< "$captured"; then
    printf '  command: %s\n  unexpected text: %s\n  received: %s\n' "$invocation" "$fragment" "$captured"
    record "$label" fail
    return
  fi
  record "$label" ok
}
has_status() {
  local label="$1" invocation="$2" expected="$3" actual
  eval "$invocation" >/dev/null 2>&1
  actual=$?
  if [[ "$actual" == "$expected" ]]; then
    record "$label" ok
  else
    printf '  command: %s\n  wanted status: %s\n  actual status: %s\n' "$invocation" "$expected" "$actual"
    record "$label" fail
  fi
}
section() { printf '\n-- %s --\n' "$1"; }
printf '=== CLI Unit Tests (no extension required) ===\n'

section 'Version and Help'
removedWrapper=$(printf '%s' 'chat''gpt')
contains_text 'version flag' 'node cli/index.cjs --version' 'lens v'
contains_text 'version alias' 'node cli/index.cjs -v' 'lens v'
contains_text 'basic help' 'node cli/index.cjs --help' 'Common Commands'
contains_text 'complete help' 'node cli/index.cjs --help-full' 'flow <commands>'
omits_text 'help excludes removed wrappers' 'node cli/index.cjs --help-full' 'chat''gpt <query>'
contains_text 'wrapper command is rejected' "node cli/index.cjs ${removedWrapper} hi 2>&1 || true" "Unknown command: ${removedWrapper}"
contains_text 'assistant shortcut is rejected' 'node cli/index.cjs ai hi 2>&1 || true' 'Unknown command: ai'
contains_text 'refs topic' 'node cli/index.cjs --help-topic refs' 'Element References'
contains_text 'selectors topic' 'node cli/index.cjs --help-topic selectors' 'CSS Selectors'
contains_text 'cookies topic' 'node cli/index.cjs --help-topic cookies' 'Cookie Management'
section 'Canonical Names and Find'
contains_text 'screenshot help' 'node cli/index.cjs screenshot --help' 'Capture screenshot'
contains_text 'page inspect help' 'node cli/index.cjs page.inspect --help' 'accessibility tree'
contains_text 'extension reload help' 'node cli/index.cjs extension.reload --help' 'Reload the Lens Chrome extension'
contains_text 'find open' 'node cli/index.cjs --find open' 'open'
contains_text 'js help' 'node cli/index.cjs js --help' 'Usage: lens js <code>'
contains_text 'headless start help' 'node cli/index.cjs headless.start --help' 'Start the local headless browser daemon'
contains_text 'bisect help' 'node cli/index.cjs bisect --help' 'Find the first commit that introduced a visual change'
contains_text 'find screenshot' 'node cli/index.cjs --find screenshot' 'screenshot'
contains_text 'find cookie' 'node cli/index.cjs --find cookie' 'cookie'
contains_text 'find wait' 'node cli/index.cjs --find wait' 'wait'
section 'About and Groups'
contains_text 'about refs' 'node cli/index.cjs --about refs' 'Element References'
contains_text 'about cookies' 'node cli/index.cjs --about cookies' 'Cookie Management'
contains_text 'about tab' 'node cli/index.cjs --about tab' 'Lens tab commands for browser work'
contains_text 'tab group' 'node cli/index.cjs tab' 'tab.list'
contains_text 'cookie group' 'node cli/index.cjs cookie' 'cookie.list'
contains_text 'scroll group' 'node cli/index.cjs scroll' 'scroll.top'
section 'Command Help'
contains_text 'click examples' 'node cli/index.cjs click --help' 'Examples'
contains_text 'type examples' 'node cli/index.cjs type --help' 'Examples'
contains_text 'click scroll flag' 'node cli/index.cjs click --help' '--scroll'
contains_text 'type scroll flag' 'node cli/index.cjs type --help' '--scroll'
contains_text 'hover scroll flag' 'node cli/index.cjs hover --help' '--scroll'
contains_text 'screenshot examples' 'node cli/index.cjs screenshot --help' 'Examples'
contains_text 'key repetition count' 'node cli/index.cjs key --help' 'times'
contains_text 'key delay' 'node cli/index.cjs key --help' 'delay-ms'
contains_text 'key repeated example' 'node cli/index.cjs key --help' 'Tab --times'
section 'Forms'
contains_text 'dropdown.choose help' 'node cli/index.cjs dropdown.choose --help' 'Choose an option in a native dropdown'
contains_text 'dropdown examples' 'node cli/index.cjs dropdown.choose --help' 'Examples'
contains_text 'dropdown by option' 'node cli/index.cjs dropdown.choose --help' '--by'
contains_text 'dropdown target required' 'node cli/index.cjs dropdown.choose 2>&1 || true' 'label-or-selector'
contains_text 'dropdown value required' 'node cli/index.cjs dropdown.choose Country 2>&1 || true' 'value'
contains_text 'form.fill help' 'node cli/index.cjs form.fill --help' 'Fill form fields from a JSON object'
contains_text 'form data flag' 'node cli/index.cjs form.fill --help' '--data'
contains_text 'form data required' 'node cli/index.cjs form.fill 2>&1 || true' '--data'
contains_text 'dropdown in full help' 'node cli/index.cjs --help-full' 'dropdown.choose'
contains_text 'form in full help' 'node cli/index.cjs --help-full' 'form.fill'
contains_text 'dropdown in listing' 'node cli/index.cjs --list' 'dropdown.choose'
contains_text 'form in listing' 'node cli/index.cjs --list' 'form.fill'
section 'Recent Commands'
contains_text 'back is documented' 'node cli/index.cjs --help-full' 'back'
contains_text 'forward is documented' 'node cli/index.cjs --help-full' 'forward'
contains_text 'zoom is documented' 'node cli/index.cjs --help-full' 'zoom'
contains_text 'bookmark is documented' 'node cli/index.cjs --help-full' 'bookmark'
contains_text 'history is documented' 'node cli/index.cjs --help-full' 'history'
contains_text 'back in command list' 'node cli/index.cjs --list' 'back'
contains_text 'zoom in command list' 'node cli/index.cjs --list' 'zoom'
printf '\n===================================\n'
printf 'Results: %s passed, %s failed\n' "$passed" "$failed"
printf '===================================\n'
((failed == 0))
