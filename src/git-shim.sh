#!/usr/bin/env bash
# Optional `git` wrapper for the review-job image (build with
# --build-arg GIT_SHIM=true to install it ahead of /usr/bin/git).
#
# OCR's code_search tool runs `git grep -i -P -n ... -e <text>` whenever the
# model sets use_perl_regexp, and models set it for literal text such as
# `falls(&self, ground:` or `[profile`. PCRE rejects the pattern
# ("fatal: -e option, 'fn step(': missing closing parenthesis") and, before
# OCR 1.14.3, the tool call silently returned nothing. 1.14.3 (upstream
# alibaba/open-code-review#1811) returns the regex error to the model instead.
# This wrapper is the older stopgap: it retries such a grep once with -F, the
# search the model meant. Every other git command is exec'd untouched. Remove
# it once 1.14.3's behaviour is confirmed on your reviews.
set -u
REAL_GIT="${OCR_REAL_GIT:-/usr/bin/git}"

is_grep=0
has_perl=0
prev=''
for arg in "$@"; do
  # The argument after -e (or --regexp) is the pattern itself, never a flag.
  if [ "$prev" != '-e' ] && [ "$prev" != '--regexp' ]; then
    case "$arg" in
      grep) is_grep=1 ;;
      -P | --perl-regexp) has_perl=1 ;;
    esac
  fi
  prev="$arg"
done
if [ "$is_grep" -eq 0 ] || [ "$has_perl" -eq 0 ]; then
  exec "$REAL_GIT" "$@"
fi

err="$(mktemp)"
trap 'rm -f "$err"' EXIT
"$REAL_GIT" "$@" 2>"$err"
rc=$?
# git reports a pattern it cannot compile as exit 128 with
# "fatal: -e option, '<pattern>': <pcre error>" (or "command line, ..." without -e).
if [ "$rc" -eq 128 ] && grep -Eq "^fatal: (-e option|command line), '" "$err"; then
  fixed=()
  prev=''
  for arg in "$@"; do
    if [ "$prev" != '-e' ] && [ "$prev" != '--regexp' ] \
      && { [ "$arg" = '-P' ] || [ "$arg" = '--perl-regexp' ]; }; then
      fixed+=(-F)
    else
      fixed+=("$arg")
    fi
    prev="$arg"
  done
  "$REAL_GIT" "${fixed[@]}"
  exit $?
fi
cat "$err" >&2
exit "$rc"
