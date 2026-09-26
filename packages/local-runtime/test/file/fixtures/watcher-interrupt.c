#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static void interrupted(int signal) { (void)signal; }
int poll(struct pollfd *fds, nfds_t count, int timeout) {
  static int injected = 0;
  int (*real_poll)(struct pollfd *, nfds_t, int) = dlsym(RTLD_NEXT, "poll");
  if (count != 2 || timeout != 500 || __sync_lock_test_and_set(&injected, 1))
    return real_poll(fds, count, timeout);
  struct sigaction action = {.sa_handler = interrupted};
  sigemptyset(&action.sa_mask);
  sigaction(SIGUSR1, &action, NULL);
  struct sigevent event = {.sigev_notify = SIGEV_THREAD_ID, .sigev_signo = SIGUSR1};
  event._sigev_un._tid = syscall(SYS_gettid);
  timer_t timer;
  if (timer_create(CLOCK_MONOTONIC, &event, &timer) != 0) _exit(91);
  struct itimerspec delay = {.it_value = {.tv_nsec = 1000000}};
  timer_settime(timer, 0, &delay, NULL);
  int result = real_poll(fds, count, timeout);
  int error = errno;
  timer_delete(timer);
  if (result == -1 && error == EINTR) {
    int fd = open(getenv("WATCHER_INTERRUPTED"), O_WRONLY | O_CREAT, 0600);
    if (fd < 0) _exit(92);
    write(fd, "EINTR", 5);
    close(fd);
  }
  errno = error;
  return result;
}
