#include <stdio.h>
#include <unistd.h>

int main(void) {
    printf("ruid=%ld euid=%ld\n", (long)getuid(), (long)geteuid());
    return 0;
}
