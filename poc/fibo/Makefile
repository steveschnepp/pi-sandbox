CC = cc
CFLAGS = -std=c99 -Wall -Wextra -Werror -pedantic -O2

.PHONY: all test clean

all: fibo

fibo: fibo.c
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $< $(LDLIBS)

test:
	./test_fibo.sh

clean:
	rm -f fibo
