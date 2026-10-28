#!/bin/sh
set -eu

src_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

compiler=${CC:-cc}
flags=${CFLAGS:--std=c99 -Wall -Wextra -Werror -pedantic -O2}
$compiler $flags "$src_dir/fibo.c" -o "$tmp_dir/fibo"

expect_output()
{
    input=$1
    expected=$2
    actual=$("$tmp_dir/fibo" "$input") || {
        printf 'FAIL: fibo %s exited nonzero\n' "$input" >&2
        exit 1
    }
    if [ "$actual" != "$expected" ]; then
        printf 'FAIL: fibo %s: expected <%s>, got <%s>\n' \
            "$input" "$expected" "$actual" >&2
        exit 1
    fi
    printf 'ok: fibo %s = %s\n' "$input" "$actual"
}

expect_failure()
{
    description=$1
    shift
    if "$tmp_dir/fibo" "$@" >"$tmp_dir/stdout" 2>"$tmp_dir/stderr"; then
        printf 'FAIL: %s unexpectedly succeeded\n' "$description" >&2
        exit 1
    fi
    printf 'ok: %s rejected\n' "$description"
}

expect_output 0 0
expect_output 1 1
expect_output 2 1
expect_output 10 55
expect_output 93 12200160415121876738
expect_failure 'negative input' -1
expect_failure 'non-numeric input' 12x
expect_failure 'overflowing Fibonacci result' 18446744073709551615
expect_failure 'out-of-range input' 9999999999999999999999999999999999999999999999999
expect_failure 'missing argument'
expect_failure 'extra argument' 5 extra

printf 'All fibo tests passed.\n'
