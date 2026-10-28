# Fibonacci CLI PoC

A small standalone C program and test script for computing Fibonacci numbers with checked `unsigned long long` overflow handling. This is a general-purpose coding PoC, separate from the Podman sandbox security experiments.

From the repository root:

```sh
make -C poc/fibo test
make -C poc/fibo
poc/fibo/fibo 93
make -C poc/fibo clean
```

The test script compiles into a temporary directory and removes it on exit. `make all` leaves the `fibo` executable in this directory; it is ignored by Git and removed by `make clean`.

Coverage includes boundary values, the largest representable Fibonacci result (`F(93)`), malformed/missing/extra arguments, and overflow rejection.
