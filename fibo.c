#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>

static int parse_index(const char *text, unsigned long long *index)
{
    const char *digit;
    char *end;
    unsigned long long value;

    if (text[0] == '\0') {
        return 0;
    }

    for (digit = text; *digit != '\0'; ++digit) {
        if (*digit < '0' || *digit > '9') {
            return 0;
        }
    }

    errno = 0;
    value = strtoull(text, &end, 10);
    if (errno == ERANGE || *end != '\0') {
        return 0;
    }

    *index = value;
    return 1;
}

int main(int argc, char **argv)
{
    unsigned long long index;
    unsigned long long current = 0;
    unsigned long long next = 1;
    unsigned long long i;

    if (argc != 2 || !parse_index(argv[1], &index)) {
        fprintf(stderr, "Usage: %s <non-negative integer>\n", argv[0]);
        return 2;
    }

    if (index < 2) {
        printf("%llu\n", index);
        return 0;
    }

    for (i = 2; i <= index; ++i) {
        unsigned long long sum;

        if (ULLONG_MAX - current < next) {
            fprintf(stderr, "fibo: result for index %llu overflows unsigned long long\n",
                    index);
            return 1;
        }

        sum = current + next;
        current = next;
        next = sum;
    }

    printf("%llu\n", next);
    return 0;
}
