"""Trusted Linux bootstrap: restrict this Python process, then load the driver.

Requires Landlock ABI 3 (Linux 6.2+) and seccomp filters on x86-64 or AArch64.
Missing kernel support is fatal, before any driver code runs. The unshare
launcher execs Python without forking, preserving Node's RSS/kill target.

Landlock controls file contents and directory changes; seccomp closes its
metadata-mutation gaps and denies process creation/exec, sockets, namespace
changes and access to other processes. stat/readlink metadata remains visible.
No Python monkeypatch is part of this boundary: restrictions survive ctypes.

Kernel ABI references:
https://docs.kernel.org/userspace-api/landlock.html
https://docs.kernel.org/userspace-api/seccomp_filter.html
https://github.com/torvalds/linux/tree/v6.17/include/uapi
https://github.com/torvalds/linux/blob/v6.17/arch/x86/entry/syscalls/syscall_64.tbl
"""

import ctypes
import errno
import os
import runpy
import sys
import sysconfig


LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.syscall.restype = ctypes.c_long
LIBC.prctl.argtypes = [ctypes.c_int] + [ctypes.c_ulong] * 4

# Columns are Linux x86-64 and asm-generic 64-bit (AArch64) syscall numbers.
# Only single-process CPython, pipes and Landlock-mediated file operations.
# In particular, metadata mutation, exec/clone, socket/IPC, signals to other
# processes, io_uring, ptrace/process_vm/pidfd and mount calls are absent.
ALLOWED_SYSCALLS = (
    (0, 63), (1, 64),                         # read, write
    (2, None), (257, 56), (437, 437),         # open, openat, openat2
    (3, 57), (436, 436),                     # close, close_range
    (4, None), (5, 80), (6, None),            # stat, fstat, lstat
    (262, 79), (332, 291),                   # newfstatat, statx
    (8, 62), (17, 67), (18, 68),             # lseek, pread64, pwrite64
    (19, 65), (20, 66),                     # readv, writev
    (21, None), (269, 48), (439, 439),       # access, faccessat, faccessat2
    (89, None), (267, 78),                  # readlink, readlinkat
    (78, None), (217, 61),                  # getdents, getdents64
    (83, None), (258, 34), (84, None),       # mkdir, mkdirat, rmdir
    (87, None), (263, 35),                  # unlink, unlinkat
    (82, None), (264, 38), (316, 276),       # rename, renameat, renameat2
    (86, None), (265, 37),                  # link, linkat
    (88, None), (266, 36),                  # symlink, symlinkat
    (76, 45), (77, 46),                    # truncate, ftruncate (Landlock ABI 3)
    (74, 82), (75, 83), (95, 166),          # fsync, fdatasync, umask
    (32, 23), (33, None), (292, 24),        # dup, dup2, dup3
    (22, None), (293, 59),                 # pipe, pipe2
    (80, 49), (81, 50), (79, 17),          # chdir, fchdir, getcwd
    (9, 222), (10, 226), (11, 215),        # mmap, mprotect, munmap
    (12, 214), (25, 216), (28, 233),       # brk, mremap, madvise
    (202, 98), (319, 279),                # futex, memfd_create (exec still denied)
    (7, None), (271, 73), (23, None), (270, 72),  # poll, ppoll, select, pselect6
    (13, 134), (14, 135), (15, 139), (131, 132),  # signal handlers/masks/return/stack
    (219, 128),                           # restart_syscall
    (228, 113), (229, 114),                # clock_gettime, clock_getres
    (35, 101), (230, 115),                 # nanosleep, clock_nanosleep
    (96, 169), (201, None), (318, 278),    # gettimeofday, time, getrandom
    (39, 172), (110, 173), (186, 178),     # getpid, getppid, gettid
    (102, 174), (107, 175), (104, 176), (108, 177), (115, 158),  # IDs/groups
    (63, 160), (98, 165),                 # uname, getrusage
    (97, 163), (160, 164), (125, 90),     # own rlimits, capget
    (60, 93), (231, 94),                  # exit, exit_group
)


class Ruleset(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class PathRule(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


class CapHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]


class CapData(ctypes.Structure):
    _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]


class Filter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint32)]


class FilterProgram(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]


def checked(result, operation):
    if result < 0:
        error = ctypes.get_errno()
        raise OSError(error, f"{operation}: {os.strerror(error)}")
    return result


def syscall(number, *args):
    return LIBC.syscall(ctypes.c_long(number), *(ctypes.c_long(arg) if isinstance(arg, int) else arg for arg in args))


def prctl(option, arg=0):
    return LIBC.prctl(option, arg, 0, 0, 0)


def restrict_filesystem(driver, workdir):
    abi = checked(syscall(444, 0, 0, 1), "query Landlock ABI")
    if abi < 3:
        raise RuntimeError(f"Landlock ABI 3 or newer required; kernel provides ABI {abi}")
    # All filesystem rights through ABI 3, including execute and truncate.
    # Newer device/socket rights need no grants: seccomp denies ioctl/socket.
    handled = (1 << 15) - 1
    read_file, read_dir = 1 << 2, 1 << 3
    scratch = sum(1 << bit for bit in (1, 2, 3, 4, 5, 7, 8, 12, 13, 14))
    readonly = {os.path.realpath(path) for path in sys.path if path and os.path.exists(path)}
    readonly.update(os.path.realpath(path) for path in (
        sysconfig.get_config_var("LIBDIR"), "/usr/lib", "/lib", "/lib64", "/nix/store",
    ) if path and os.path.isdir(path))
    # Do not let a broad scratch path turn the readonly runtime or driver writable.
    for path in (*readonly, driver, os.path.realpath(__file__)):
        if os.path.commonpath((path, workdir)) == workdir:
            raise RuntimeError("scratch directory overlaps the readonly runtime or driver")
    attr = Ruleset(handled)
    ruleset = checked(syscall(444, ctypes.byref(attr), ctypes.sizeof(attr), 0), "create Landlock ruleset")

    def allow(path, rights):
        fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        try:
            rule = PathRule(rights, fd)
            checked(syscall(445, ruleset, 1, ctypes.byref(rule), 0), f"Landlock rule for {path}")
        finally:
            os.close(fd)

    try:
        for path in readonly:
            allow(path, read_file | (read_dir if os.path.isdir(path) else 0))
        for path in (driver, os.path.realpath(__file__), os.path.realpath(sys.executable), "/dev/urandom", "/etc/ld.so.cache"):
            if os.path.isfile(path) or path == "/dev/urandom":
                allow(path, read_file)
        allow("/dev/null", read_file | (1 << 1))
        allow(workdir, scratch)
        checked(syscall(446, ruleset, 0), "enforce Landlock ruleset")
    finally:
        os.close(ruleset)


def drop_capabilities(column):
    for capability in range(64):
        present = prctl(23, capability)  # PR_CAPBSET_READ
        if present < 0 and ctypes.get_errno() == errno.EINVAL:
            break
        checked(present, "read capability bounding set")
        if present:
            checked(prctl(24, capability), "drop capability bounding set")
    checked(LIBC.prctl(47, 4, 0, 0, 0), "clear ambient capabilities")
    header, caps = CapHeader(0x20080522, 0), (CapData * 2)()
    checked(syscall((126, 91)[column], ctypes.byref(header), caps), "clear process capabilities")


def restrict_syscalls(column):
    allow, deny = 0x7FFF0000, 0x00050000 | errno.EPERM
    # BPF_LD|W|ABS, JMP|JEQ|K, RET|K. Reject other architectures and x32.
    instructions = [
        (0x20, 0, 0, 4), (0x15, 1, 0, (0xC000003E, 0xC00000B7)[column]),
        (0x06, 0, 0, 0x80000000), (0x20, 0, 0, 0),
        (0x35, 0, 1, 0x40000000), (0x06, 0, 0, deny),
    ]

    def allow_argument(number, index, values):
        # seccomp_data.args[] is 64-bit. Require a zero high word as well.
        block = [(0x20, 0, 0, 20 + 8 * index), (0x15, 1, 0, 0), (0x06, 0, 0, deny),
                 (0x20, 0, 0, 16 + 8 * index)]
        for value in values:
            block.extend(((0x15, 0, 1, value), (0x06, 0, 0, allow)))
        block.append((0x06, 0, 0, deny))
        instructions.append((0x15, 0, len(block), number))
        instructions.extend(block)

    allow_argument((302, 261)[column], 0, (0,))  # prlimit64: this process only
    allow_argument((157, 167)[column], 0, (21, 23, 39))  # prctl: inspect seccomp/bounds/no_new_privs
    allow_argument((72, 25)[column], 1, (0, 1, 2, 3, 4, 1030))  # fcntl: FD/status only
    for numbers in ALLOWED_SYSCALLS:
        number = numbers[column]
        if number is not None:
            instructions.extend(((0x15, 0, 1, number), (0x06, 0, 0, allow)))
    instructions.append((0x06, 0, 0, deny))
    filters = (Filter * len(instructions))(*(Filter(*item) for item in instructions))
    program = FilterProgram(len(filters), filters)
    checked(LIBC.prctl(22, 2, ctypes.addressof(program), 0, 0), "install seccomp filter")


def main():
    machine = os.uname().machine
    if machine not in ("x86_64", "aarch64") or ctypes.sizeof(ctypes.c_void_p) != 8:
        raise RuntimeError(f"unsupported Linux sandbox architecture: {machine}")
    column = 0 if machine == "x86_64" else 1
    driver, workdir = (os.path.realpath(value) for value in sys.argv[1:])
    if not os.path.isfile(driver) or not os.path.isdir(workdir):
        raise RuntimeError("driver must be a regular file and scratch must be a directory")
    # Landlock does not revoke already-open descriptors. Node passes only the
    # three protocol pipes; close anything else before installing restrictions.
    for entry in os.listdir("/proc/self/fd"):
        fd = int(entry)
        if fd > 2:
            try:
                os.close(fd)
            except OSError as error:
                if error.errno != errno.EBADF:
                    raise
    os.chdir(workdir)
    checked(prctl(38, 1), "set no_new_privs")
    restrict_filesystem(driver, workdir)
    drop_capabilities(column)
    restrict_syscalls(column)
    sys.argv = [driver]
    runpy.run_path(driver, run_name="__main__")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"sandbox_violation: Linux sandbox setup/driver failed: {error}", file=sys.stderr)
        sys.exit(1)
