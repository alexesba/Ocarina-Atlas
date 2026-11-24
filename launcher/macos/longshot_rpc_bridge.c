#define _DARWIN_C_SOURCE

#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <limits.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <math.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/types.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <time.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define GUEST_WINDOW_BASE 0x100000000000ULL
#define GUEST_WINDOW_SIZE 0x8000000000ULL
#define GUEST_CODE_BASE 0x80000000ULL
#define LONGSHOT_HEAP_BASE 0x1000000000ULL
#define LONGSHOT_HEAP_END 0x2000000000ULL
#define STANDARD_HEAP_THRESHOLD 0x2000000000ULL
#define DIRECT_HOST_ADDR_MIN 0x100000000ULL
#define DIRECT_HOST_ADDR_MAX 0x8000000000ULL
#define DIRECT_HOST_CODE_START 0x7000000000ULL
#define DIRECT_HOST_CODE_END 0x8000000000ULL

#define MAX_READ_MEMORY_SIZE 262144
#define MAX_SEARCH_PATTERN_BYTES 4096
#define SEARCH_CHUNK_SIZE 1048576
#define DEFAULT_MAX_HITS 64
#define MAX_ALLOWED_HITS 1024
#define MAX_JSON_DEPTH 32
#define MAX_RPC_CLIENTS 16
#define DEFAULT_BRIDGE_PORT 6545
#define OOT_PROGRAM_ID "0400486024DEC000"

typedef struct {
    pid_t pid;
    uint64_t starttime;
    bool has_starttime;
    mach_port_t task;
    char emulator[32];
    char save_dir[PATH_MAX];
    bool has_save_dir;
    bool attached;
    bool is_direct_host_va;
    bool task_access_denied;
    kern_return_t task_kr;
} target_state_t;

typedef struct {
    uint64_t start;
    uint64_t end;
} mem_region_t;

typedef struct {
    mem_region_t *items;
    size_t count;
    size_t capacity;
} region_list_t;

typedef struct {
    uint64_t *items;
    size_t count;
    size_t capacity;
} hit_list_t;

typedef struct client_node {
    int fd;
    pthread_t thread;
    bool finished;
    struct client_node *next;
} client_node_t;

static volatile sig_atomic_t g_stop = 0;
static pthread_mutex_t g_target_mutex = PTHREAD_MUTEX_INITIALIZER;
static target_state_t g_target = {0, 0, false, MACH_PORT_NULL, "longshot", "", false, false, false, false, KERN_SUCCESS};
static pid_t g_forced_pid = 0;
static bool g_task_for_pid_warned = false;
static pthread_mutex_t g_diag_mutex = PTHREAD_MUTEX_INITIALIZER;
static bool g_once_mode = false;

static pthread_mutex_t g_clients_mutex = PTHREAD_MUTEX_INITIALIZER;
static client_node_t *g_clients_head = NULL;
static size_t g_active_clients = 0;

static void on_signal(int sig) {
    (void)sig;
    g_stop = 1;
}

static uint64_t monotonic_ms(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) {
        return 0;
    }
    return (uint64_t)ts.tv_sec * 1000ULL + (uint64_t)(ts.tv_nsec / 1000000L);
}

static void release_task_port(mach_port_t *task) {
    if (task && *task != MACH_PORT_NULL) {
        if (*task != mach_task_self()) {
            (void)mach_port_deallocate(mach_task_self(), *task);
        }
        *task = MACH_PORT_NULL;
    }
}

static const char *classify_target_name(const char *name) {
    if (!name || !*name) {
        return NULL;
    }
    if (strcasecmp(name, "hookshot") == 0 ||
        strcasecmp(name, "longshot") == 0) {
        return "longshot";
    }
    if (strcasecmp(name, "heylisten") == 0) {
        return "heylisten";
    }
    if (strcasecmp(name, "relink-game") == 0 || strcasecmp(name, "relink") == 0) {
        return "relink";
    }
    if (strcasecmp(name, "triforce") == 0) {
        return "triforce";
    }
    if (strcasecmp(name, "ocarina") == 0 || strcasecmp(name, "nx2navi") == 0) {
        return "ootpc";
    }
    if (strcasecmp(name, "rekarina") == 0) {
        return "rekarina";
    }
    return NULL;
}

static bool is_direct_host_va_emulator(const char *emu) {
    return emu && (strcasecmp(emu, "ootpc") == 0 || strcasecmp(emu, "rekarina") == 0);
}

static bool ends_with_ignore_case(const char *str, size_t len, const char *suffix) {
    size_t slen = strlen(suffix);
    if (len < slen) {
        return false;
    }
    return strcasecmp(str + (len - slen), suffix) == 0;
}

static const char *match_normalized_target(const char *raw_name, bool allow_truncated_comm) {
    (void)allow_truncated_comm;
    if (!raw_name || !*raw_name) {
        return NULL;
    }

    const char *base = raw_name;
    for (const char *p = raw_name; *p; p++) {
        if (*p == '/' || *p == '\\') {
            base = p + 1;
        }
    }
    if (!*base) {
        return NULL;
    }

    size_t raw_len = strlen(base);
    char buf[256];
    if (raw_len >= sizeof(buf)) {
        raw_len = sizeof(buf) - 1;
    }
    memcpy(buf, base, raw_len);
    buf[raw_len] = '\0';

    size_t len = raw_len;
    bool stripped = true;
    while (stripped) {
        stripped = false;
        static const char *const suffixes[] = {".exe", ".app", ".x86_64"};
        for (size_t i = 0; i < sizeof(suffixes) / sizeof(suffixes[0]); i++) {
            if (ends_with_ignore_case(buf, len, suffixes[i])) {
                len -= strlen(suffixes[i]);
                buf[len] = '\0';
                stripped = true;
                break;
            }
        }
    }

    return classify_target_name(buf);
}

static bool read_proc_bsd_info(pid_t pid, uint32_t *out_status, uint64_t *out_starttime) {
    if (pid <= 0) {
        return false;
    }
    struct proc_bsdinfo bsd;
    memset(&bsd, 0, sizeof(bsd));
    int n = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, (int)sizeof(bsd));
    if (n != (int)sizeof(bsd)) {
        return false;
    }
    if (out_status) {
        *out_status = bsd.pbi_status;
    }
    if (out_starttime) {
        *out_starttime = ((uint64_t)bsd.pbi_start_tvsec * 1000000ULL) + (uint64_t)bsd.pbi_start_tvusec;
    }
    return true;
}

static bool is_pid_alive(pid_t pid, bool check_starttime, uint64_t expected_starttime) {
    if (pid <= 0) {
        return false;
    }
    if (kill(pid, 0) != 0 && errno == ESRCH) {
        return false;
    }
    uint32_t status = 0;
    uint64_t starttime = 0;
    if (!read_proc_bsd_info(pid, &status, check_starttime ? &starttime : NULL)) {
        return false;
    }
    /* SZOMB == 5 in XNU sys/proc.h */
    if (status == 5U) {
        return false;
    }
    if (check_starttime && starttime != expected_starttime) {
        return false;
    }
    return true;
}

static void print_task_for_pid_diagnostic_once(pid_t pid, kern_return_t kr) {
    pthread_mutex_lock(&g_diag_mutex);
    if (g_task_for_pid_warned) {
        pthread_mutex_unlock(&g_diag_mutex);
        return;
    }
    g_task_for_pid_warned = true;
    pthread_mutex_unlock(&g_diag_mutex);
    fprintf(stderr,
        "[longshot-rpc-bridge] Read-only task_for_pid(%ld) failed (%s, kr=%d).\n"
        "  On macOS, task_for_pid is restricted by Hardened Runtime and System Integrity Protection (SIP):\n"
        "    1) Run the target game/emulator without Hardened Runtime, or signed with com.apple.security.get-task-allow.\n"
        "    2) Sign this bridge with com.apple.security.cs.debugger (or enable DevToolsSecurity: sudo DevToolsSecurity -enable).\n"
        "    3) If SIP blocks attachment to a signed third-party app/Wine binary, run an ad-hoc/unsigned build or use save-file tracking.\n",
        (long)pid, mach_error_string(kr), (int)kr);
}

static int kern_return_to_errno(kern_return_t kr) {
    if (kr == KERN_SUCCESS) {
        return 0;
    }
    if (kr == KERN_FAILURE || kr == KERN_PROTECTION_FAILURE || kr == KERN_NO_ACCESS) {
        return EPERM;
    }
    if (kr == KERN_INVALID_ADDRESS) {
        return EFAULT;
    }
    return EINVAL;
}

static bool read_remote_memory_task(mach_port_t task, uint64_t remote_addr, void *buf, size_t size, int *out_errno) {
    if (out_errno) {
        *out_errno = 0;
    }
    if (task == MACH_PORT_NULL || !buf || size == 0) {
        if (out_errno) *out_errno = EINVAL;
        return false;
    }

    uint8_t *dst = (uint8_t *)buf;
    size_t total = 0;
    while (total < size) {
        mach_vm_size_t chunk = (mach_vm_size_t)(size - total);
        mach_vm_size_t out_size = 0;
        kern_return_t kr = mach_vm_read_overwrite(
            task,
            (mach_vm_address_t)(remote_addr + total),
            chunk,
            (mach_vm_address_t)(uintptr_t)(dst + total),
            &out_size);
        if (kr != KERN_SUCCESS || out_size == 0 || out_size > chunk) {
            if (out_errno) {
                *out_errno = (kr == KERN_SUCCESS) ? EFAULT : kern_return_to_errno(kr);
            }
            return false;
        }
        total += (size_t)out_size;
    }
    return true;
}

static bool verify_guest_code_mapped(pid_t pid, mach_port_t task, bool is_direct_host_va, int *out_err) {
    if (out_err) {
        *out_err = 0;
    }
    if (task == MACH_PORT_NULL) {
        if (out_err) *out_err = EINVAL;
        return false;
    }

    uint64_t probe_addr = is_direct_host_va
        ? DIRECT_HOST_CODE_START
        : (GUEST_WINDOW_BASE + GUEST_CODE_BASE);
    bool found_mapping = false;

    if (is_direct_host_va) {
        mach_vm_address_t addr = (mach_vm_address_t)DIRECT_HOST_CODE_START;
        while (addr < (mach_vm_address_t)DIRECT_HOST_CODE_END) {
            mach_vm_size_t size = 0;
            vm_region_basic_info_data_64_t info;
            mach_msg_type_number_t count = VM_REGION_BASIC_INFO_COUNT_64;
            mach_port_t object_name = MACH_PORT_NULL;
            kern_return_t kr = mach_vm_region(
                task,
                &addr,
                &size,
                VM_REGION_BASIC_INFO_64,
                (vm_region_info_t)&info,
                &count,
                &object_name);
            if (object_name != MACH_PORT_NULL) {
                (void)mach_port_deallocate(mach_task_self(), object_name);
            }
            if (kr != KERN_SUCCESS) {
                break;
            }
            uint64_t start = (uint64_t)addr;
            uint64_t end = (addr > UINT64_MAX - size) ? UINT64_MAX : (uint64_t)(addr + size);
            if (start >= DIRECT_HOST_CODE_END) {
                break;
            }
            if ((info.protection & VM_PROT_READ) != 0 && end > DIRECT_HOST_CODE_START) {
                uint64_t ov_start = start > DIRECT_HOST_CODE_START ? start : DIRECT_HOST_CODE_START;
                uint64_t ov_end = end < DIRECT_HOST_CODE_END ? end : DIRECT_HOST_CODE_END;
                if (ov_end - ov_start >= 8ULL) {
                    probe_addr = ov_start;
                    found_mapping = true;
                    break;
                }
            }
            if (size == 0 || addr > UINT64_MAX - size) {
                break;
            }
            addr += size;
        }
    } else {
        mach_vm_address_t addr = (mach_vm_address_t)probe_addr;
        mach_vm_size_t size = 0;
        vm_region_basic_info_data_64_t info;
        mach_msg_type_number_t count = VM_REGION_BASIC_INFO_COUNT_64;
        mach_port_t object_name = MACH_PORT_NULL;
        kern_return_t kr = mach_vm_region(
            task,
            &addr,
            &size,
            VM_REGION_BASIC_INFO_64,
            (vm_region_info_t)&info,
            &count,
            &object_name);
        if (object_name != MACH_PORT_NULL) {
            (void)mach_port_deallocate(mach_task_self(), object_name);
        }
        if (kr == KERN_SUCCESS &&
            (info.protection & VM_PROT_READ) != 0 &&
            (uint64_t)addr <= probe_addr &&
            size >= 8ULL &&
            (addr > UINT64_MAX - size || (uint64_t)(addr + size) >= probe_addr + 8ULL)) {
            found_mapping = true;
        }
    }

    if (!found_mapping) {
        return false;
    }

    uint8_t probe[8];
    int read_err = 0;
    if (!read_remote_memory_task(task, probe_addr, probe, sizeof(probe), &read_err)) {
        if (read_err == EPERM) {
            print_task_for_pid_diagnostic_once(pid, KERN_PROTECTION_FAILURE);
        }
        if (out_err) *out_err = read_err;
        return false;
    }
    return true;
}

static bool dir_exists(const char *path) {
    if (!path || !*path) {
        return false;
    }
    struct stat st;
    return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

static void normalize_possible_wine_path(const char *raw_path, char *out_buf, size_t out_cap) {
    if (!out_buf || out_cap == 0) {
        return;
    }
    out_buf[0] = '\0';
    if (!raw_path || !*raw_path) {
        return;
    }
    const char *src = raw_path;
    if ((src[0] == 'Z' || src[0] == 'z') && src[1] == ':' && (src[2] == '\\' || src[2] == '/')) {
        src += 2;
    }
    size_t j = 0;
    for (size_t i = 0; src[i] != '\0' && j + 1 < out_cap; i++) {
        out_buf[j++] = (src[i] == '\\') ? '/' : src[i];
    }
    out_buf[j] = '\0';
    while (j > 1 && out_buf[j - 1] == '/') {
        out_buf[--j] = '\0';
    }
}

static bool extract_game_root_from_exe_path(const char *raw_exe_path, char *out_buf, size_t out_cap) {
    if (!raw_exe_path || !*raw_exe_path || !out_buf || out_cap == 0) {
        return false;
    }
    char exe_path[PATH_MAX];
    normalize_possible_wine_path(raw_exe_path, exe_path, sizeof(exe_path));
    if (!exe_path[0]) {
        return false;
    }

    char *last_slash = strrchr(exe_path, '/');
    if (!last_slash || last_slash == exe_path) {
        return false;
    }
    *last_slash = '\0';

    size_t dir_len = strlen(exe_path);
    while (dir_len > 1 && exe_path[dir_len - 1] == '/') {
        exe_path[--dir_len] = '\0';
    }

    char *leaf = strrchr(exe_path, '/');
    const char *leaf_name = leaf ? (leaf + 1) : exe_path;
    if (strcasecmp(leaf_name, "bin") == 0 && leaf && leaf != exe_path) {
        *leaf = '\0';
    }

    int written = snprintf(out_buf, out_cap, "%s", exe_path);
    return written > 0 && (size_t)written < out_cap;
}

static bool try_resolve_game_root_save_dir(const char *raw_exe_path, char *out_buf, size_t out_cap) {
    char game_root[PATH_MAX];
    if (!extract_game_root_from_exe_path(raw_exe_path, game_root, sizeof(game_root))) {
        return false;
    }

    char candidate_user[PATH_MAX];
    char candidate_save[PATH_MAX];
    int uw = snprintf(candidate_user, sizeof(candidate_user), "%s/user", game_root);
    int sw = snprintf(candidate_save, sizeof(candidate_save), "%s/user/save", game_root);
    if (uw > 0 && (size_t)uw < sizeof(candidate_user) &&
        sw > 0 && (size_t)sw < sizeof(candidate_save) &&
        dir_exists(candidate_save)) {
        int w = snprintf(out_buf, out_cap, "%s", candidate_user);
        return w > 0 && (size_t)w < out_cap;
    }

    /* Rekarina / NX2Saria-style <game_root>/profile/save */
    int puw = snprintf(candidate_user, sizeof(candidate_user), "%s/profile", game_root);
    int psw = snprintf(candidate_save, sizeof(candidate_save), "%s/profile/save", game_root);
    if (puw > 0 && (size_t)puw < sizeof(candidate_user) &&
        psw > 0 && (size_t)psw < sizeof(candidate_save) &&
        dir_exists(candidate_save)) {
        int w = snprintf(out_buf, out_cap, "%s", candidate_user);
        return w > 0 && (size_t)w < out_cap;
    }

    /* Check portable LongshotLauncher-data/user (walking up 1-3 parent directories). */
    char parent_dir[PATH_MAX];
    snprintf(parent_dir, sizeof(parent_dir), "%s", game_root);
    for (int depth = 0; depth < 3; depth++) {
        char *slash = strrchr(parent_dir, '/');
        if (!slash || slash == parent_dir) {
            break;
        }
        *slash = '\0';

        int parent_uw = snprintf(candidate_user, sizeof(candidate_user), "%s/user", parent_dir);
        int parent_sw = snprintf(candidate_save, sizeof(candidate_save), "%s/user/save", parent_dir);
        if (parent_uw > 0 && (size_t)parent_uw < sizeof(candidate_user) &&
            parent_sw > 0 && (size_t)parent_sw < sizeof(candidate_save) &&
            dir_exists(candidate_save)) {
            int w = snprintf(out_buf, out_cap, "%s", candidate_user);
            return w > 0 && (size_t)w < out_cap;
        }

        int pw = snprintf(candidate_user, sizeof(candidate_user), "%s/LongshotLauncher-data/user", parent_dir);
        if (pw > 0 && (size_t)pw < sizeof(candidate_user) && dir_exists(candidate_user)) {
            int w = snprintf(out_buf, out_cap, "%s", candidate_user);
            return w > 0 && (size_t)w < out_cap;
        }

        const char *parent_leaf = strrchr(parent_dir, '/');
        parent_leaf = parent_leaf ? (parent_leaf + 1) : parent_dir;
        if (strcasecmp(parent_leaf, "LongshotLauncher-data") == 0) {
            int lw = snprintf(candidate_user, sizeof(candidate_user), "%s/user", parent_dir);
            if (lw > 0 && (size_t)lw < sizeof(candidate_user) && dir_exists(candidate_user)) {
                int w = snprintf(out_buf, out_cap, "%s", candidate_user);
                return w > 0 && (size_t)w < out_cap;
            }
        }
    }

    return false;
}

static bool read_proc_args2(pid_t pid, char **out_buf, size_t *out_len, int *out_argc) {
    int mib[3] = {CTL_KERN, KERN_PROCARGS2, (int)pid};
    size_t size = 0;
    if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0 || size < sizeof(int)) {
        return false;
    }
    if (size > 262144) {
        size = 262144;
    }
    char *buf = (char *)malloc(size + 1);
    if (!buf) {
        return false;
    }
    if (sysctl(mib, 3, buf, &size, NULL, 0) != 0 || size < sizeof(int)) {
        free(buf);
        return false;
    }
    buf[size] = '\0';
    int nargs = 0;
    memcpy(&nargs, buf, sizeof(int));
    if (nargs <= 0 || nargs > 4096) {
        free(buf);
        return false;
    }
    *out_buf = buf;
    *out_len = size;
    *out_argc = nargs;
    return true;
}

static bool try_resolve_relink_launcher_ini(const char *ini_path, char *out_buf, size_t out_cap) {
    if (!ini_path || !*ini_path || !out_buf || out_cap == 0) {
        return false;
    }
    FILE *fp = fopen(ini_path, "r");
    if (!fp) {
        return false;
    }

    char line[PATH_MAX + 128];
    bool found = false;
    while (fgets(line, (int)sizeof(line), fp) != NULL) {
        char *p = line;
        while (*p && isspace((unsigned char)*p)) {
            p++;
        }
        if (*p == '\0' || *p == '#' || *p == ';' || *p == '[') {
            continue;
        }
        char *eq = strchr(p, '=');
        if (!eq) {
            continue;
        }
        *eq = '\0';
        char *key_end = eq;
        while (key_end > p && isspace((unsigned char)key_end[-1])) {
            *--key_end = '\0';
        }
        if (strcasecmp(p, "game_folder") != 0) {
            continue;
        }

        char *val = eq + 1;
        while (*val && isspace((unsigned char)*val)) {
            val++;
        }
        size_t vlen = strlen(val);
        while (vlen > 0 && isspace((unsigned char)val[vlen - 1])) {
            val[--vlen] = '\0';
        }
        if (vlen >= 2 && ((val[0] == '"' && val[vlen - 1] == '"') ||
                          (val[0] == '\'' && val[vlen - 1] == '\''))) {
            val[vlen - 1] = '\0';
            val++;
        }
        if (!*val) {
            continue;
        }

        char norm_dir[PATH_MAX];
        normalize_possible_wine_path(val, norm_dir, sizeof(norm_dir));
        if (!norm_dir[0]) {
            continue;
        }

        char candidate_user[PATH_MAX];
        char candidate_save[PATH_MAX];
        int uw = snprintf(candidate_user, sizeof(candidate_user), "%s/user", norm_dir);
        int sw = snprintf(candidate_save, sizeof(candidate_save), "%s/user/save", norm_dir);
        if (uw > 0 && (size_t)uw < sizeof(candidate_user) &&
            sw > 0 && (size_t)sw < sizeof(candidate_save) &&
            dir_exists(candidate_save)) {
            int w = snprintf(out_buf, out_cap, "%s", candidate_user);
            if (w > 0 && (size_t)w < out_cap) {
                found = true;
                break;
            }
        }
        int dw = snprintf(candidate_save, sizeof(candidate_save), "%s/save", norm_dir);
        if (dw > 0 && (size_t)dw < sizeof(candidate_save) && dir_exists(candidate_save)) {
            int w = snprintf(out_buf, out_cap, "%s", norm_dir);
            if (w > 0 && (size_t)w < out_cap) {
                found = true;
                break;
            }
        }
    }

    fclose(fp);
    return found;
}

static bool resolve_user_save_dir(pid_t pid, const char *emulator, char *out_buf, size_t out_cap) {
    if (!out_buf || out_cap == 0) {
        return false;
    }
    out_buf[0] = '\0';

    char wine_exe_path[PATH_MAX];
    wine_exe_path[0] = '\0';

    char *args_buf = NULL;
    size_t args_len = 0;
    int nargs = 0;
    if (read_proc_args2(pid, &args_buf, &args_len, &nargs)) {
        size_t pos = sizeof(int);
        while (pos < args_len && args_buf[pos] != '\0') {
            pos++;
        }
        while (pos < args_len && args_buf[pos] == '\0') {
            pos++;
        }
        for (int i = 0; i < nargs && pos < args_len; i++) {
            const char *tok = args_buf + pos;
            size_t tlen = strlen(tok);
            pos += tlen + 1;
            if (tlen == 0) {
                continue;
            }

            if (strcmp(tok, "--user") == 0 && i + 1 < nargs && pos < args_len) {
                const char *val = args_buf + pos;
                pos += strlen(val) + 1;
                i++;
                char user_dir[PATH_MAX];
                normalize_possible_wine_path(val, user_dir, sizeof(user_dir));
                if (dir_exists(user_dir)) {
                    int w = snprintf(out_buf, out_cap, "%s", user_dir);
                    if (w > 0 && (size_t)w < out_cap) {
                        free(args_buf);
                        return true;
                    }
                    out_buf[0] = '\0';
                }
                continue;
            }

            if (strncmp(tok, "--user=", 7) == 0 && tok[7] != '\0') {
                char user_dir[PATH_MAX];
                normalize_possible_wine_path(tok + 7, user_dir, sizeof(user_dir));
                if (dir_exists(user_dir)) {
                    int w = snprintf(out_buf, out_cap, "%s", user_dir);
                    if (w > 0 && (size_t)w < out_cap) {
                        free(args_buf);
                        return true;
                    }
                    out_buf[0] = '\0';
                }
                continue;
            }

            if ((tok[0] == 'Z' || tok[0] == 'z') && tok[1] == ':' && (tok[2] == '\\' || tok[2] == '/')) {
                if (!wine_exe_path[0] || match_normalized_target(tok, false) != NULL) {
                    snprintf(wine_exe_path, sizeof(wine_exe_path), "%s", tok);
                }
            }
        }
        free(args_buf);
    }

    if (wine_exe_path[0] && try_resolve_game_root_save_dir(wine_exe_path, out_buf, out_cap)) {
        return true;
    }

    char exe_path[PROC_PIDPATHINFO_MAXSIZE];
    int path_len = proc_pidpath(pid, exe_path, (uint32_t)sizeof(exe_path));
    if (path_len > 0) {
        if ((size_t)path_len >= sizeof(exe_path)) {
            exe_path[sizeof(exe_path) - 1] = '\0';
        } else {
            exe_path[path_len] = '\0';
        }
        if (try_resolve_game_root_save_dir(exe_path, out_buf, out_cap)) {
            return true;
        }
    }

    const char *home = getenv("HOME");
    if (!home || !*home) {
        out_buf[0] = '\0';
        return false;
    }

    char home_clean[PATH_MAX];
    snprintf(home_clean, sizeof(home_clean), "%s", home);
    size_t hlen = strlen(home_clean);
    while (hlen > 1 && home_clean[hlen - 1] == '/') {
        home_clean[--hlen] = '\0';
    }

    char app_support[PATH_MAX];
    int asw = snprintf(app_support, sizeof(app_support), "%s/Library/Application Support", home_clean);
    if (asw <= 0 || (size_t)asw >= sizeof(app_support)) {
        out_buf[0] = '\0';
        return false;
    }

    if (emulator && strcmp(emulator, "relink") == 0) {
        /* Project ReLink on macOS uses ~/Library/Application Support/relink, launcher.ini, or ~/Games/{ProjectReLink,ReLink}/user; never fall back to Longshot. */
        char candidate_save[PATH_MAX];
        int rw = snprintf(candidate_save, sizeof(candidate_save), "%s/relink/save", app_support);
        if (rw > 0 && (size_t)rw < sizeof(candidate_save) && dir_exists(candidate_save)) {
            int w = snprintf(out_buf, out_cap, "%s/relink", app_support);
            if (w > 0 && (size_t)w < out_cap) {
                return true;
            }
        }
        static const char *const relink_inis[] = {
            "%s/ReLink/launcher.ini",
            "%s/relink/launcher.ini",
        };
        for (size_t i = 0; i < sizeof(relink_inis) / sizeof(relink_inis[0]); i++) {
            char ini_path[PATH_MAX];
            int iw = snprintf(ini_path, sizeof(ini_path), relink_inis[i], app_support);
            if (iw > 0 && (size_t)iw < sizeof(ini_path) &&
                try_resolve_relink_launcher_ini(ini_path, out_buf, out_cap)) {
                return true;
            }
        }
        static const char *const relink_games[] = {
            "%s/Games/ProjectReLink/user",
            "%s/Games/ProjectReLink/game/user",
            "%s/Games/ReLink/user",
            "%s/Games/ReLink/game/user",
        };
        for (size_t i = 0; i < sizeof(relink_games) / sizeof(relink_games[0]); i++) {
            char candidate_user[PATH_MAX];
            int cw = snprintf(candidate_user, sizeof(candidate_user), relink_games[i], home_clean);
            int sw = snprintf(candidate_save, sizeof(candidate_save), "%s/save", candidate_user);
            if (cw > 0 && (size_t)cw < sizeof(candidate_user) &&
                sw > 0 && (size_t)sw < sizeof(candidate_save) &&
                dir_exists(candidate_save)) {
                int w = snprintf(out_buf, out_cap, "%s", candidate_user);
                if (w > 0 && (size_t)w < out_cap) {
                    return true;
                }
            }
        }
        out_buf[0] = '\0';
        return false;
    }

    if (emulator && strcmp(emulator, "rekarina") == 0) {
        /* Rekarina keeps saves in <game_root>/profile/save or ~/Games/Rekarina/game/profile; never Longshot. */
        static const char *const rekarina_roots[] = {
            "%s/Games/Rekarina/game/profile",
            "%s/Games/Rekarina/profile",
            "%s/Library/Application Support/Rekarina/game/profile",
            "%s/Library/Application Support/Rekarina/profile",
        };
        for (size_t i = 0; i < sizeof(rekarina_roots) / sizeof(rekarina_roots[0]); i++) {
            char candidate_user[PATH_MAX];
            char candidate_save[PATH_MAX];
            int cw = snprintf(candidate_user, sizeof(candidate_user), rekarina_roots[i], home_clean);
            int sw = snprintf(candidate_save, sizeof(candidate_save), "%s/save", candidate_user);
            if (cw > 0 && (size_t)cw < sizeof(candidate_user) &&
                sw > 0 && (size_t)sw < sizeof(candidate_save) &&
                dir_exists(candidate_save)) {
                int w = snprintf(out_buf, out_cap, "%s", candidate_user);
                if (w > 0 && (size_t)w < out_cap) {
                    return true;
                }
            }
        }
        out_buf[0] = '\0';
        return false;
    }

    char candidate_save[PATH_MAX];
    int sw1 = snprintf(candidate_save, sizeof(candidate_save), "%s/longshot/user/save", app_support);
    if (sw1 > 0 && (size_t)sw1 < sizeof(candidate_save) && dir_exists(candidate_save)) {
        int w = snprintf(out_buf, out_cap, "%s/longshot/user", app_support);
        if (w > 0 && (size_t)w < out_cap) {
            return true;
        }
        out_buf[0] = '\0';
    }
    int sw2 = snprintf(candidate_save, sizeof(candidate_save), "%s/longshot/save", app_support);
    if (sw2 > 0 && (size_t)sw2 < sizeof(candidate_save) && dir_exists(candidate_save)) {
        int w = snprintf(out_buf, out_cap, "%s/longshot", app_support);
        if (w > 0 && (size_t)w < out_cap) {
            return true;
        }
        out_buf[0] = '\0';
    }

    static const char *const games_candidates[] = {
        "%s/Games/Longshot/user",
        "%s/Games/Hookshot/user",
        "%s/Games/HeyListen/user",
        "%s/Games/Triforce/user",
        "%s/Games/Ocarina/user",
        "%s/Games/Ocarina/profile",
        "%s/Games/ProjectReLink/user",
        "%s/Games/ProjectReLink/game/user",
        "%s/Games/ReLink/user",
        "%s/Games/ReLink/game/user",
    };
    for (size_t i = 0; i < sizeof(games_candidates) / sizeof(games_candidates[0]); i++) {
        char candidate_user[PATH_MAX];
        int cw = snprintf(candidate_user, sizeof(candidate_user), games_candidates[i], home_clean);
        int sw = snprintf(candidate_save, sizeof(candidate_save), "%s/save", candidate_user);
        if (cw > 0 && (size_t)cw < sizeof(candidate_user) &&
            sw > 0 && (size_t)sw < sizeof(candidate_save) &&
            dir_exists(candidate_save)) {
            int w = snprintf(out_buf, out_cap, "%s", candidate_user);
            if (w > 0 && (size_t)w < out_cap) {
                return true;
            }
        }
    }

    out_buf[0] = '\0';
    return false;
}

static bool match_cmdline_process(pid_t pid, const char **out_emulator) {
    char *args_buf = NULL;
    size_t args_len = 0;
    int nargs = 0;
    if (!read_proc_args2(pid, &args_buf, &args_len, &nargs)) {
        return false;
    }

    size_t pos = sizeof(int);
    while (pos < args_len && args_buf[pos] != '\0') {
        pos++;
    }
    while (pos < args_len && args_buf[pos] == '\0') {
        pos++;
    }

    bool matched = false;
    for (int i = 0; i < nargs && pos < args_len; i++) {
        const char *tok = args_buf + pos;
        size_t tlen = strlen(tok);
        pos += tlen + 1;
        if (tlen == 0 || tok[0] == '-') {
            continue;
        }
        const char *emu = match_normalized_target(tok, false);
        if (emu) {
            *out_emulator = emu;
            matched = true;
            break;
        }
    }

    free(args_buf);
    return matched;
}

static bool match_proc_name(pid_t pid, const char **out_emulator) {
    char proc_comm[256];
    int nlen = proc_name(pid, proc_comm, (uint32_t)sizeof(proc_comm));
    if (nlen > 0) {
        if ((size_t)nlen >= sizeof(proc_comm)) {
            proc_comm[sizeof(proc_comm) - 1] = '\0';
        } else {
            proc_comm[nlen] = '\0';
        }
        const char *emu = match_normalized_target(proc_comm, false);
        if (emu) {
            *out_emulator = emu;
            return true;
        }
    }

    char exe_path[PROC_PIDPATHINFO_MAXSIZE];
    int path_len = proc_pidpath(pid, exe_path, (uint32_t)sizeof(exe_path));
    if (path_len > 0) {
        if ((size_t)path_len >= sizeof(exe_path)) {
            exe_path[sizeof(exe_path) - 1] = '\0';
        } else {
            exe_path[path_len] = '\0';
        }
        const char *emu = match_normalized_target(exe_path, false);
        if (emu) {
            *out_emulator = emu;
            return true;
        }
    }

    if (match_cmdline_process(pid, out_emulator)) {
        return true;
    }

    return false;
}

static bool acquire_target_task(pid_t pid, mach_port_t *out_task, bool warn_on_fail, kern_return_t *out_kr) {
    mach_port_t task = MACH_PORT_NULL;
    kern_return_t kr = task_for_pid(mach_task_self(), pid, &task);
    if (out_kr) {
        *out_kr = kr;
    }
    if (kr != KERN_SUCCESS || task == MACH_PORT_NULL) {
        if (warn_on_fail && (kr == KERN_FAILURE || kr == KERN_PROTECTION_FAILURE || kr == KERN_NO_ACCESS)) {
            print_task_for_pid_diagnostic_once(pid, kr);
        }
        return false;
    }
    *out_task = task;
    return true;
}

static bool inspect_candidate_target(pid_t pid, const char *emu, bool acquire_task, target_state_t *out_state) {
    bool direct_host_va = is_direct_host_va_emulator(emu);
    mach_port_t task = MACH_PORT_NULL;
    kern_return_t kr = KERN_SUCCESS;
    bool got_task = acquire_target_task(pid, &task, acquire_task, &kr);

    if (got_task) {
        int verify_err = 0;
        if (!verify_guest_code_mapped(pid, task, direct_host_va, &verify_err)) {
            release_task_port(&task);
            return false;
        }
    } else if (acquire_task) {
        return false;
    }

    out_state->pid = pid;
    out_state->has_starttime = read_proc_bsd_info(pid, NULL, &out_state->starttime);
    out_state->task = (acquire_task && got_task) ? task : MACH_PORT_NULL;
    if (!acquire_task && got_task) {
        release_task_port(&task);
    }
    snprintf(out_state->emulator, sizeof(out_state->emulator), "%s", emu);
    out_state->has_save_dir = resolve_user_save_dir(pid, emu, out_state->save_dir, sizeof(out_state->save_dir));
    out_state->attached = acquire_task && got_task;
    out_state->is_direct_host_va = direct_host_va;
    out_state->task_access_denied = !got_task;
    out_state->task_kr = kr;
    return true;
}

static bool discover_target(target_state_t *out_state, bool acquire_task) {
    memset(out_state, 0, sizeof(*out_state));
    out_state->task = MACH_PORT_NULL;
    snprintf(out_state->emulator, sizeof(out_state->emulator), "longshot");

    if (g_forced_pid > 0) {
        if (!is_pid_alive(g_forced_pid, false, 0)) {
            return false;
        }
        const char *emu = "longshot";
        match_proc_name(g_forced_pid, &emu);
        return inspect_candidate_target(g_forced_pid, emu, acquire_task, out_state);
    }

    int buf_bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
    if (buf_bytes <= 0) {
        return false;
    }
    size_t cap = (size_t)buf_bytes + 64 * sizeof(pid_t);
    pid_t *pids = (pid_t *)malloc(cap);
    if (!pids) {
        return false;
    }
    int actual_bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, (int)cap);
    if (actual_bytes <= 0) {
        free(pids);
        return false;
    }
    size_t count = (size_t)actual_bytes / sizeof(pid_t);
    pid_t self_pid = getpid();

    for (size_t i = 0; i < count; i++) {
        pid_t pid = pids[i];
        if (pid <= 0 || pid == self_pid) {
            continue;
        }

        const char *emu = NULL;
        if (!match_proc_name(pid, &emu)) {
            continue;
        }

        if (inspect_candidate_target(pid, emu, acquire_task, out_state)) {
            free(pids);
            return true;
        }
    }

    free(pids);
    return false;
}

static bool refresh_target_locked(bool allow_discover) {
    if (g_target.attached) {
        if (is_pid_alive(g_target.pid, g_target.has_starttime, g_target.starttime)) {
            return true;
        }
        fprintf(stderr, "[longshot-rpc-bridge] Target PID %ld exited.\n", (long)g_target.pid);
        release_task_port(&g_target.task);
        g_target.attached = false;
        g_target.is_direct_host_va = false;
        g_target.pid = 0;
        g_target.starttime = 0;
        g_target.has_starttime = false;
        g_target.save_dir[0] = '\0';
        g_target.has_save_dir = false;
        if (g_once_mode) {
            g_stop = 1;
            return false;
        }
    }

    if (!allow_discover || g_stop) {
        return false;
    }

    target_state_t found;
    if (discover_target(&found, true)) {
        release_task_port(&g_target.task);
        g_target = found;
        fprintf(stderr,
            "[longshot-rpc-bridge] Attached read-only to PID %ld (%s, saves: %s).\n",
            (long)g_target.pid,
            g_target.emulator,
            g_target.has_save_dir ? g_target.save_dir : "none");
        return true;
    }
    return false;
}

static bool collect_readable_regions_task(mach_port_t task, uint64_t range_start, uint64_t range_end, region_list_t *out_list) {
    out_list->items = NULL;
    out_list->count = 0;
    out_list->capacity = 0;

    if (task == MACH_PORT_NULL) {
        return false;
    }
    if (range_end <= range_start) {
        return true;
    }

    mach_vm_address_t addr = (mach_vm_address_t)range_start;
    while (addr < (mach_vm_address_t)range_end) {
        mach_vm_size_t size = 0;
        vm_region_basic_info_data_64_t info;
        mach_msg_type_number_t count = VM_REGION_BASIC_INFO_COUNT_64;
        mach_port_t object_name = MACH_PORT_NULL;
        kern_return_t kr = mach_vm_region(
            task,
            &addr,
            &size,
            VM_REGION_BASIC_INFO_64,
            (vm_region_info_t)&info,
            &count,
            &object_name);
        if (object_name != MACH_PORT_NULL) {
            (void)mach_port_deallocate(mach_task_self(), object_name);
        }
        if (kr != KERN_SUCCESS) {
            break;
        }
        if (addr >= (mach_vm_address_t)range_end) {
            break;
        }

        if (size > 0 && (info.protection & VM_PROT_READ) != 0) {
            uint64_t start = (uint64_t)addr;
            uint64_t end = (addr > UINT64_MAX - size) ? UINT64_MAX : (uint64_t)(addr + size);
            uint64_t clipped_start = start > range_start ? start : range_start;
            uint64_t clipped_end = end < range_end ? end : range_end;
            if (clipped_end > clipped_start) {
                if (out_list->count > 0 && out_list->items[out_list->count - 1].end == clipped_start) {
                    out_list->items[out_list->count - 1].end = clipped_end;
                } else {
                    if (out_list->count == out_list->capacity) {
                        size_t next_cap = out_list->capacity == 0 ? 64 : out_list->capacity * 2;
                        mem_region_t *grown = (mem_region_t *)realloc(out_list->items, next_cap * sizeof(mem_region_t));
                        if (!grown) {
                            free(out_list->items);
                            out_list->items = NULL;
                            out_list->count = 0;
                            out_list->capacity = 0;
                            return false;
                        }
                        out_list->items = grown;
                        out_list->capacity = next_cap;
                    }
                    out_list->items[out_list->count].start = clipped_start;
                    out_list->items[out_list->count].end = clipped_end;
                    out_list->count++;
                }
            }
        }

        if (size == 0 || addr > UINT64_MAX - size) {
            break;
        }
        addr += size;
    }

    return true;
}

static bool add_hit(hit_list_t *hits, uint64_t guest_addr) {
    if (hits->count == hits->capacity) {
        size_t next_cap = hits->capacity == 0 ? 32 : hits->capacity * 2;
        uint64_t *grown = (uint64_t *)realloc(hits->items, next_cap * sizeof(uint64_t));
        if (!grown) {
            return false;
        }
        hits->items = grown;
        hits->capacity = next_cap;
    }
    hits->items[hits->count++] = guest_addr;
    return true;
}

static void match_buffer(
    const uint8_t *buf,
    size_t buf_len,
    uint64_t base_host_addr,
    uint64_t guest_base,
    const uint8_t *pattern_bytes,
    const uint8_t *pattern_mask,
    size_t pattern_len,
    ssize_t anchor_idx,
    size_t max_hits,
    hit_list_t *hits
) {
    if (buf_len < pattern_len || pattern_len == 0) {
        return;
    }
    size_t max_start = buf_len - pattern_len;

    if (anchor_idx < 0) {
        for (size_t i = 0; i <= max_start && hits->count < max_hits; i++) {
            uint64_t guest_addr = (base_host_addr + (uint64_t)i) - guest_base;
            if (!add_hit(hits, guest_addr)) {
                break;
            }
        }
        return;
    }

    uint8_t anchor_byte = pattern_bytes[anchor_idx];
    size_t search_pos = (size_t)anchor_idx;
    size_t search_end = max_start + (size_t)anchor_idx;

    while (search_pos <= search_end && hits->count < max_hits) {
        const uint8_t *found = (const uint8_t *)memchr(
            buf + search_pos,
            anchor_byte,
            (search_end - search_pos) + 1);
        if (!found) {
            break;
        }
        size_t found_idx = (size_t)(found - buf);
        size_t start = found_idx - (size_t)anchor_idx;

        bool matched = true;
        for (size_t k = 0; k < pattern_len; k++) {
            if (pattern_mask[k] && buf[start + k] != pattern_bytes[k]) {
                matched = false;
                break;
            }
        }
        if (matched) {
            uint64_t guest_addr = (base_host_addr + (uint64_t)start) - guest_base;
            if (!add_hit(hits, guest_addr)) {
                break;
            }
        }

        search_pos = found_idx + 1;
    }
}

static void search_host_range(
    mach_port_t task,
    uint64_t range_start_host,
    uint64_t range_end_host,
    uint64_t guest_base,
    const uint8_t *pattern_bytes,
    const uint8_t *pattern_mask,
    size_t pattern_len,
    ssize_t anchor_idx,
    size_t max_hits,
    hit_list_t *hits,
    uint64_t start_ms,
    int budget_ms,
    uint8_t *scan_buf,
    size_t scan_buf_len
) {
    region_list_t regions;
    if (!collect_readable_regions_task(task, range_start_host, range_end_host, &regions)) {
        return;
    }

    size_t overlap = pattern_len - 1;
    for (size_t r = 0; r < regions.count && hits->count < max_hits && !g_stop; r++) {
        if (budget_ms > 0 && (monotonic_ms() - start_ms) >= (uint64_t)budget_ms) {
            break;
        }
        uint64_t scan_start = regions.items[r].start;
        uint64_t scan_end = regions.items[r].end;
        if (scan_end <= scan_start || (scan_end - scan_start) < pattern_len) {
            continue;
        }

        uint64_t cursor = scan_start;
        while (cursor < scan_end && hits->count < max_hits && !g_stop) {
            if (budget_ms > 0 && (monotonic_ms() - start_ms) >= (uint64_t)budget_ms) {
                break;
            }
            uint64_t remaining = scan_end - cursor;
            if (remaining < pattern_len) {
                break;
            }
            size_t to_read = remaining > (uint64_t)scan_buf_len
                ? scan_buf_len
                : (size_t)remaining;

            int read_err = 0;
            if (!read_remote_memory_task(task, cursor, scan_buf, to_read, &read_err)) {
                break;
            }

            match_buffer(
                scan_buf,
                to_read,
                cursor,
                guest_base,
                pattern_bytes,
                pattern_mask,
                pattern_len,
                anchor_idx,
                max_hits,
                hits);

            if (cursor + (uint64_t)to_read >= scan_end || to_read <= overlap) {
                break;
            }
            cursor += (uint64_t)(to_read - overlap);
        }
    }

    free(regions.items);
}

static bool hex_nibble(char c, uint8_t *out) {
    if (c >= '0' && c <= '9') { *out = (uint8_t)(c - '0'); return true; }
    if (c >= 'a' && c <= 'f') { *out = (uint8_t)(c - 'a' + 10); return true; }
    if (c >= 'A' && c <= 'F') { *out = (uint8_t)(c - 'A' + 10); return true; }
    return false;
}

static bool parse_hex_pattern(const char *pattern, uint8_t **out_bytes, uint8_t **out_mask, size_t *out_len) {
    if (!pattern || !*pattern) {
        return false;
    }

    size_t raw_len = strlen(pattern);
    char *clean = (char *)malloc(raw_len + 1);
    if (!clean) {
        return false;
    }

    size_t clean_len = 0;
    for (size_t i = 0; i < raw_len; i++) {
        if (!isspace((unsigned char)pattern[i])) {
            clean[clean_len++] = pattern[i];
        }
    }
    clean[clean_len] = '\0';

    if (clean_len < 2 || (clean_len % 2) != 0) {
        free(clean);
        return false;
    }

    size_t byte_len = clean_len / 2;
    uint8_t *bytes = (uint8_t *)malloc(byte_len);
    uint8_t *mask = (uint8_t *)malloc(byte_len);
    if (!bytes || !mask) {
        free(clean);
        free(bytes);
        free(mask);
        return false;
    }

    for (size_t i = 0; i < byte_len; i++) {
        char hi = clean[i * 2];
        char lo = clean[i * 2 + 1];
        if (hi == '?' && lo == '?') {
            bytes[i] = 0;
            mask[i] = 0;
        } else {
            uint8_t h = 0, l = 0;
            if (!hex_nibble(hi, &h) || !hex_nibble(lo, &l)) {
                free(clean);
                free(bytes);
                free(mask);
                return false;
            }
            bytes[i] = (uint8_t)((h << 4) | l);
            mask[i] = 1;
        }
    }

    free(clean);
    *out_bytes = bytes;
    *out_mask = mask;
    *out_len = byte_len;
    return true;
}

static bool parse_u64_str(const char *s, uint64_t *out) {
    if (!s) {
        return false;
    }
    while (*s && isspace((unsigned char)*s)) {
        s++;
    }
    if (!*s) {
        return false;
    }
    char *endp = NULL;
    errno = 0;
    unsigned long long v;
    if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) {
        if (!isxdigit((unsigned char)s[2])) {
            return false;
        }
        v = strtoull(s + 2, &endp, 16);
    } else {
        if (!isdigit((unsigned char)s[0])) {
            return false;
        }
        v = strtoull(s, &endp, 10);
    }
    if (errno != 0 || endp == s) {
        return false;
    }
    while (*endp && isspace((unsigned char)*endp)) {
        endp++;
    }
    if (*endp != '\0') {
        return false;
    }
    *out = (uint64_t)v;
    return true;
}

/* Minimal, strict JSON helper for Lichii JSON-RPC request objects */
typedef struct {
    bool has_id;
    char id_json[256];
    bool has_method;
    char method[64];
    bool has_params;

    bool has_address;
    uint64_t address;
    bool has_size;
    int64_t size;

    bool has_pattern;
    char *pattern;
    bool has_regions;
    char regions[64];
    bool has_start;
    uint64_t start;
    bool has_end;
    uint64_t end;
    bool has_max_hits;
    int64_t max_hits;
    bool has_budget_ms;
    int64_t budget_ms;
} rpc_request_t;

static void rpc_request_free(rpc_request_t *req) {
    if (req->pattern) {
        free(req->pattern);
        req->pattern = NULL;
    }
}

static const char *skip_ws(const char *p) {
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') {
        p++;
    }
    return p;
}

static bool parse_json_string_alloc(const char **pp, char **out_str) {
    const char *p = *pp;
    if (*p != '"') {
        return false;
    }
    p++;

    size_t cap = 64;
    size_t len = 0;
    char *buf = (char *)malloc(cap);
    if (!buf) {
        return false;
    }

    while (*p != '\0' && *p != '"') {
        unsigned char c = (unsigned char)*p;
        if (c < 0x20) {
            free(buf);
            return false;
        }
        char ch;
        if (c == '\\') {
            p++;
            if (*p == '\0') {
                free(buf);
                return false;
            }
            switch (*p) {
                case '"': ch = '"'; break;
                case '\\': ch = '\\'; break;
                case '/': ch = '/'; break;
                case 'b': ch = '\b'; break;
                case 'f': ch = '\f'; break;
                case 'n': ch = '\n'; break;
                case 'r': ch = '\r'; break;
                case 't': ch = '\t'; break;
                case 'u': {
                    uint32_t cp = 0;
                    for (int i = 0; i < 4; i++) {
                        p++;
                        uint8_t nib = 0;
                        if (!hex_nibble(*p, &nib)) {
                            free(buf);
                            return false;
                        }
                        cp = (cp << 4) | nib;
                    }
                    if (cp == 0) {
                        free(buf);
                        return false;
                    }
                    ch = (cp < 0x80) ? (char)cp : '?';
                    break;
                }
                default:
                    free(buf);
                    return false;
            }
            p++;
        } else {
            ch = (char)*p;
            p++;
        }

        if (len + 2 > cap) {
            size_t next_cap = cap * 2;
            char *grown = (char *)realloc(buf, next_cap);
            if (!grown) {
                free(buf);
                return false;
            }
            buf = grown;
            cap = next_cap;
        }
        buf[len++] = ch;
    }

    if (*p != '"') {
        free(buf);
        return false;
    }
    p++;
    buf[len] = '\0';
    *pp = p;
    if (out_str) {
        *out_str = buf;
    } else {
        free(buf);
    }
    return true;
}

static bool skip_json_value(const char **pp, int depth);

static bool skip_json_container(const char **pp, char open_ch, char close_ch, int depth) {
    if (depth >= MAX_JSON_DEPTH) {
        return false;
    }
    const char *p = *pp;
    if (*p != open_ch) {
        return false;
    }
    p = skip_ws(p + 1);
    if (*p == close_ch) {
        *pp = p + 1;
        return true;
    }
    for (;;) {
        if (open_ch == '{') {
            if (!parse_json_string_alloc(&p, NULL)) {
                return false;
            }
            p = skip_ws(p);
            if (*p != ':') {
                return false;
            }
            p = skip_ws(p + 1);
        }
        if (!skip_json_value(&p, depth + 1)) {
            return false;
        }
        p = skip_ws(p);
        if (*p == ',') {
            p = skip_ws(p + 1);
            continue;
        }
        if (*p == close_ch) {
            *pp = p + 1;
            return true;
        }
        return false;
    }
}

static bool scan_json_number(const char *p, const char **out_end) {
    if (!p) {
        return false;
    }
    if (*p == '-') {
        p++;
    }
    if (!isdigit((unsigned char)*p)) {
        return false;
    }
    if (*p == '0') {
        p++;
        if (isdigit((unsigned char)*p) || *p == 'x' || *p == 'X') {
            return false;
        }
    } else {
        while (isdigit((unsigned char)*p)) {
            p++;
        }
    }
    if (*p == '.') {
        p++;
        if (!isdigit((unsigned char)*p)) {
            return false;
        }
        while (isdigit((unsigned char)*p)) {
            p++;
        }
    }
    if (*p == 'e' || *p == 'E') {
        p++;
        if (*p == '+' || *p == '-') {
            p++;
        }
        if (!isdigit((unsigned char)*p)) {
            return false;
        }
        while (isdigit((unsigned char)*p)) {
            p++;
        }
    }
    if (out_end) {
        *out_end = p;
    }
    return true;
}

static bool skip_json_value(const char **pp, int depth) {
    if (depth > MAX_JSON_DEPTH) {
        return false;
    }
    const char *p = skip_ws(*pp);
    if (*p == '"') {
        *pp = p;
        return parse_json_string_alloc(pp, NULL);
    }
    if (*p == '{') {
        *pp = p;
        return skip_json_container(pp, '{', '}', depth);
    }
    if (*p == '[') {
        *pp = p;
        return skip_json_container(pp, '[', ']', depth);
    }
    if (strncmp(p, "true", 4) == 0) {
        *pp = p + 4;
        return true;
    }
    if (strncmp(p, "false", 5) == 0) {
        *pp = p + 5;
        return true;
    }
    if (strncmp(p, "null", 4) == 0) {
        *pp = p + 4;
        return true;
    }
    if (*p == '-' || isdigit((unsigned char)*p)) {
        const char *num_end = NULL;
        if (!scan_json_number(p, &num_end)) {
            return false;
        }
        *pp = num_end;
        return true;
    }
    return false;
}

static bool parse_json_int_or_u64(const char **pp, bool *is_uint, uint64_t *uval, int64_t *ival) {
    const char *p = skip_ws(*pp);
    if (*p == '"') {
        char *s = NULL;
        if (!parse_json_string_alloc(&p, &s)) {
            return false;
        }
        bool ok = parse_u64_str(s, uval);
        free(s);
        if (!ok) {
            return false;
        }
        *is_uint = true;
        *ival = (*uval <= (uint64_t)INT64_MAX) ? (int64_t)*uval : INT64_MAX;
        *pp = p;
        return true;
    }

    if (*p == '-' || isdigit((unsigned char)*p)) {
        const char *num_end = NULL;
        if (!scan_json_number(p, &num_end)) {
            return false;
        }
        char *endp = NULL;
        if (*p == '-') {
            errno = 0;
            long long v = strtoll(p, &endp, 10);
            if (endp == p) {
                return false;
            }
            if (*endp == '.' || *endp == 'e' || *endp == 'E') {
                errno = 0;
                double dv = strtod(p, &endp);
                if (endp != num_end || !isfinite(dv) || errno == ERANGE ||
                    dv < (double)INT64_MIN || dv >= 9223372036854775808.0) {
                    return false;
                }
                *ival = (int64_t)dv;
                *uval = dv >= 0.0 ? (uint64_t)dv : 0ULL;
            } else {
                if (endp != num_end || errno != 0) {
                    return false;
                }
                *ival = (int64_t)v;
                *uval = v >= 0 ? (uint64_t)v : 0ULL;
            }
            *is_uint = false;
            *pp = endp;
            return true;
        }
        errno = 0;
        unsigned long long uv = strtoull(p, &endp, 10);
        if (endp == p) {
            return false;
        }
        if (*endp == '.' || *endp == 'e' || *endp == 'E') {
            errno = 0;
            double dv = strtod(p, &endp);
            if (endp != num_end || !isfinite(dv) || errno == ERANGE) {
                return false;
            }
            if (dv < 0.0) {
                if (dv < (double)INT64_MIN) {
                    return false;
                }
                *is_uint = false;
                *uval = 0ULL;
                *ival = (int64_t)dv;
            } else {
                if (dv >= 18446744073709551616.0) {
                    return false;
                }
                *is_uint = true;
                *uval = (uint64_t)dv;
                *ival = (*uval <= (uint64_t)INT64_MAX) ? (int64_t)*uval : INT64_MAX;
            }
            *pp = endp;
            return true;
        }
        if (endp != num_end || errno != 0) {
            return false;
        }
        *is_uint = true;
        *uval = (uint64_t)uv;
        *ival = (*uval <= (uint64_t)INT64_MAX) ? (int64_t)*uval : INT64_MAX;
        *pp = endp;
        return true;
    }
    return false;
}

static bool parse_params_object(const char **pp, rpc_request_t *req) {
    const char *p = skip_ws(*pp);
    if (strncmp(p, "null", 4) == 0) {
        *pp = p + 4;
        return true;
    }
    if (*p != '{') {
        return false;
    }
    p = skip_ws(p + 1);
    if (*p == '}') {
        *pp = p + 1;
        req->has_params = true;
        return true;
    }

    req->has_params = true;
    for (;;) {
        char *key = NULL;
        if (!parse_json_string_alloc(&p, &key)) {
            return false;
        }
        p = skip_ws(p);
        if (*p != ':') {
            free(key);
            return false;
        }
        p = skip_ws(p + 1);

        if (strcmp(key, "address") == 0) {
            bool is_u = false;
            uint64_t u = 0;
            int64_t iv = 0;
            if (parse_json_int_or_u64(&p, &is_u, &u, &iv) && is_u) {
                req->has_address = true;
                req->address = u;
            } else {
                free(key);
                return false;
            }
        } else if (strcmp(key, "size") == 0) {
            bool is_u = false;
            uint64_t u = 0;
            int64_t iv = 0;
            if (!parse_json_int_or_u64(&p, &is_u, &u, &iv)) {
                free(key);
                return false;
            }
            req->has_size = true;
            req->size = iv;
        } else if (strcmp(key, "pattern") == 0) {
            char *pat = NULL;
            if (!parse_json_string_alloc(&p, &pat)) {
                free(key);
                return false;
            }
            free(req->pattern);
            req->pattern = pat;
            req->has_pattern = true;
        } else if (strcmp(key, "regions") == 0) {
            if (strncmp(p, "null", 4) == 0) {
                p += 4;
            } else {
                char *reg = NULL;
                if (!parse_json_string_alloc(&p, &reg)) {
                    free(key);
                    return false;
                }
                snprintf(req->regions, sizeof(req->regions), "%s", reg);
                free(reg);
                req->has_regions = true;
            }
        } else if (strcmp(key, "start") == 0) {
            if (strncmp(p, "null", 4) == 0) {
                p += 4;
            } else {
                bool is_u = false;
                uint64_t u = 0;
                int64_t iv = 0;
                if (!parse_json_int_or_u64(&p, &is_u, &u, &iv) || !is_u) {
                    free(key);
                    return false;
                }
                req->has_start = true;
                req->start = u;
            }
        } else if (strcmp(key, "end") == 0) {
            if (strncmp(p, "null", 4) == 0) {
                p += 4;
            } else {
                bool is_u = false;
                uint64_t u = 0;
                int64_t iv = 0;
                if (!parse_json_int_or_u64(&p, &is_u, &u, &iv) || !is_u) {
                    free(key);
                    return false;
                }
                req->has_end = true;
                req->end = u;
            }
        } else if (strcmp(key, "max_hits") == 0) {
            bool is_u = false;
            uint64_t u = 0;
            int64_t iv = 0;
            if (!parse_json_int_or_u64(&p, &is_u, &u, &iv)) {
                free(key);
                return false;
            }
            req->has_max_hits = true;
            req->max_hits = iv;
        } else if (strcmp(key, "budget_ms") == 0) {
            bool is_u = false;
            uint64_t u = 0;
            int64_t iv = 0;
            if (!parse_json_int_or_u64(&p, &is_u, &u, &iv)) {
                free(key);
                return false;
            }
            req->has_budget_ms = true;
            req->budget_ms = iv;
        } else {
            if (!skip_json_value(&p, 0)) {
                free(key);
                return false;
            }
        }

        free(key);
        p = skip_ws(p);
        if (*p == ',') {
            p = skip_ws(p + 1);
            continue;
        }
        if (*p == '}') {
            *pp = p + 1;
            return true;
        }
        return false;
    }
}

static bool parse_rpc_request(const char *line, rpc_request_t *req) {
    memset(req, 0, sizeof(*req));
    snprintf(req->id_json, sizeof(req->id_json), "null");

    const char *p = skip_ws(line);
    if (*p != '{') {
        return false;
    }
    p = skip_ws(p + 1);
    if (*p == '}') {
        return true;
    }

    for (;;) {
        char *key = NULL;
        if (!parse_json_string_alloc(&p, &key)) {
            rpc_request_free(req);
            return false;
        }
        p = skip_ws(p);
        if (*p != ':') {
            free(key);
            rpc_request_free(req);
            return false;
        }
        p = skip_ws(p + 1);

        if (strcmp(key, "id") == 0) {
            const char *val_start = p;
            if (!skip_json_value(&p, 0)) {
                free(key);
                rpc_request_free(req);
                return false;
            }
            size_t id_len = (size_t)(p - val_start);
            if (id_len > 0 && id_len < sizeof(req->id_json)) {
                memcpy(req->id_json, val_start, id_len);
                req->id_json[id_len] = '\0';
                req->has_id = true;
            }
        } else if (strcmp(key, "method") == 0) {
            char *m = NULL;
            if (!parse_json_string_alloc(&p, &m)) {
                free(key);
                rpc_request_free(req);
                return false;
            }
            snprintf(req->method, sizeof(req->method), "%s", m);
            free(m);
            req->has_method = true;
        } else if (strcmp(key, "params") == 0) {
            if (!parse_params_object(&p, req)) {
                free(key);
                rpc_request_free(req);
                return false;
            }
        } else {
            if (!skip_json_value(&p, 0)) {
                free(key);
                rpc_request_free(req);
                return false;
            }
        }

        free(key);
        p = skip_ws(p);
        if (*p == ',') {
            p = skip_ws(p + 1);
            continue;
        }
        if (*p == '}') {
            p = skip_ws(p + 1);
            return *p == '\0';
        }
        rpc_request_free(req);
        return false;
    }
}

static bool send_all(int fd, const char *data, size_t len) {
    size_t sent = 0;
    while (sent < len && !g_stop) {
#ifdef MSG_NOSIGNAL
        ssize_t n = send(fd, data + sent, len - sent, MSG_NOSIGNAL);
#else
        ssize_t n = send(fd, data + sent, len - sent, 0);
#endif
        if (n > 0) {
            sent += (size_t)n;
            continue;
        }
        if (n < 0 && errno == EINTR) {
            continue;
        }
        return false;
    }
    return sent == len;
}

static void send_json_error(int fd, const char *id_json, int code, const char *message) {
    char buf[512];
    int n = snprintf(buf, sizeof(buf),
        "{\"id\":%s,\"error\":{\"code\":%d,\"message\":\"%s\"}}\n",
        id_json ? id_json : "null",
        code,
        message ? message : "Error");
    if (n > 0 && (size_t)n < sizeof(buf)) {
        (void)send_all(fd, buf, (size_t)n);
    }
}

static mach_port_t retain_target_task_locked(bool alive) {
    if (!alive || g_target.task == MACH_PORT_NULL) {
        return MACH_PORT_NULL;
    }
    if (mach_port_mod_refs(mach_task_self(), g_target.task, MACH_PORT_RIGHT_SEND, 1) != KERN_SUCCESS) {
        return MACH_PORT_NULL;
    }
    return g_target.task;
}

static bool handle_rpc_line(int fd, const char *line) {
    rpc_request_t req;
    if (!parse_rpc_request(line, &req)) {
        send_json_error(fd, "null", -32700, "Parse error");
        return false;
    }

    if (!req.has_method || req.method[0] == '\0') {
        send_json_error(fd, req.id_json, -32600, "Missing method");
        rpc_request_free(&req);
        return true;
    }

    if (strcmp(req.method, "status") == 0) {
        pthread_mutex_lock(&g_target_mutex);
        bool alive = refresh_target_locked(true);
        char emu[32];
        snprintf(emu, sizeof(emu), "%s", g_target.emulator);
        pthread_mutex_unlock(&g_target_mutex);

        char resp[512];
        int n;
        if (alive) {
            n = snprintf(resp, sizeof(resp),
                "{\"id\":%s,\"result\":{\"powered_on\":true,\"program_id\":\"%s\",\"emulator\":\"%s\"}}\n",
                req.id_json, OOT_PROGRAM_ID, emu);
        } else {
            n = snprintf(resp, sizeof(resp),
                "{\"id\":%s,\"result\":{\"powered_on\":false,\"program_id\":\"\",\"emulator\":\"%s\"}}\n",
                req.id_json, emu);
        }
        if (n > 0 && (size_t)n < sizeof(resp)) {
            (void)send_all(fd, resp, (size_t)n);
        }
        rpc_request_free(&req);
        return true;
    }

    if (strcmp(req.method, "read_memory") == 0) {
        if (!req.has_params || !req.has_address || !req.has_size ||
            req.size < 1 || req.size > MAX_READ_MEMORY_SIZE) {
            send_json_error(fd, req.id_json, -32602, "Invalid read_memory params");
            rpc_request_free(&req);
            return true;
        }

        pthread_mutex_lock(&g_target_mutex);
        bool alive = refresh_target_locked(true);
        mach_port_t task = retain_target_task_locked(alive);
        bool is_direct_host_va = alive && g_target.is_direct_host_va;
        pthread_mutex_unlock(&g_target_mutex);

        uint64_t guest_base = is_direct_host_va ? 0ULL : GUEST_WINDOW_BASE;
        uint64_t addr_min = is_direct_host_va ? DIRECT_HOST_ADDR_MIN : 0ULL;
        uint64_t addr_max = is_direct_host_va ? DIRECT_HOST_ADDR_MAX : GUEST_WINDOW_SIZE;
        if (req.address < addr_min || req.address >= addr_max || (uint64_t)req.size > addr_max - req.address) {
            release_task_port(&task);
            send_json_error(fd, req.id_json, -32602, "Address out of guest window");
            rpc_request_free(&req);
            return true;
        }

        size_t sz = (size_t)req.size;
        uint8_t *raw = (uint8_t *)malloc(sz);
        if (!raw) {
            release_task_port(&task);
            send_json_error(fd, req.id_json, -32000, "Out of memory");
            rpc_request_free(&req);
            return true;
        }

        int read_err = 0;
        bool ok = (task != MACH_PORT_NULL) && read_remote_memory_task(task, guest_base + req.address, raw, sz, &read_err);
        release_task_port(&task);
        if (!ok) {
            free(raw);
            send_json_error(fd, req.id_json, -32000, "read_memory failed");
            rpc_request_free(&req);
            return true;
        }

        size_t id_len = strlen(req.id_json);
        size_t resp_cap = id_len + (sz * 2) + 64;
        char *resp = (char *)malloc(resp_cap);
        if (!resp) {
            free(raw);
            send_json_error(fd, req.id_json, -32000, "Out of memory");
            rpc_request_free(&req);
            return true;
        }

        int prefix = snprintf(resp, resp_cap, "{\"id\":%s,\"result\":{\"hex\":\"", req.id_json);
        static const char hex_chars[] = "0123456789abcdef";
        char *out = resp + prefix;
        for (size_t i = 0; i < sz; i++) {
            out[i * 2] = hex_chars[raw[i] >> 4];
            out[i * 2 + 1] = hex_chars[raw[i] & 0x0F];
        }
        memcpy(out + (sz * 2), "\"}}\n", 5);
        (void)send_all(fd, resp, (size_t)prefix + (sz * 2) + 4);

        free(resp);
        free(raw);
        rpc_request_free(&req);
        return true;
    }

    if (strcmp(req.method, "search_memory") == 0) {
        uint8_t *pat_bytes = NULL;
        uint8_t *pat_mask = NULL;
        size_t pat_len = 0;
        if (!req.has_params || !req.has_pattern ||
            !parse_hex_pattern(req.pattern, &pat_bytes, &pat_mask, &pat_len) ||
            pat_len > MAX_SEARCH_PATTERN_BYTES) {
            free(pat_bytes);
            free(pat_mask);
            send_json_error(fd, req.id_json, -32602, "Invalid search_memory pattern");
            rpc_request_free(&req);
            return true;
        }

        bool is_heap = req.has_regions && strcasecmp(req.regions, "heap") == 0;

        size_t max_hits = DEFAULT_MAX_HITS;
        if (req.has_max_hits) {
            if (req.max_hits < 1) max_hits = 1;
            else if (req.max_hits > MAX_ALLOWED_HITS) max_hits = MAX_ALLOWED_HITS;
            else max_hits = (size_t)req.max_hits;
        }

        int budget_ms = 10000;
        if (req.has_budget_ms) {
            if (req.budget_ms < 50) {
                budget_ms = 50;
            } else if (req.budget_ms > 10000) {
                budget_ms = 10000;
            } else {
                budget_ms = (int)req.budget_ms;
            }
        }

        ssize_t anchor_idx = -1;
        for (size_t i = 0; i < pat_len; i++) {
            if (pat_mask[i] && pat_bytes[i] != 0x00 && pat_bytes[i] != 0xFF) {
                anchor_idx = (ssize_t)i;
                break;
            }
        }
        if (anchor_idx < 0) {
            for (size_t i = 0; i < pat_len; i++) {
                if (pat_mask[i]) {
                    anchor_idx = (ssize_t)i;
                    break;
                }
            }
        }

        size_t scan_buf_len = pat_len > SEARCH_CHUNK_SIZE ? pat_len : SEARCH_CHUNK_SIZE;
        uint8_t *scan_buf = (uint8_t *)malloc(scan_buf_len);
        if (!scan_buf) {
            free(pat_bytes);
            free(pat_mask);
            send_json_error(fd, req.id_json, -32000, "Out of memory");
            rpc_request_free(&req);
            return true;
        }

        pthread_mutex_lock(&g_target_mutex);
        bool alive = refresh_target_locked(true);
        mach_port_t task = retain_target_task_locked(alive);
        bool is_direct_host_va = alive && g_target.is_direct_host_va;
        pthread_mutex_unlock(&g_target_mutex);

        uint64_t guest_base = is_direct_host_va ? 0ULL : GUEST_WINDOW_BASE;
        uint64_t addr_min = is_direct_host_va ? DIRECT_HOST_ADDR_MIN : 0ULL;
        uint64_t addr_max = is_direct_host_va ? DIRECT_HOST_ADDR_MAX : GUEST_WINDOW_SIZE;
        uint64_t default_heap_start = is_direct_host_va ? DIRECT_HOST_ADDR_MIN : STANDARD_HEAP_THRESHOLD;
        uint64_t guest_start = req.has_start ? req.start : (is_heap ? default_heap_start : addr_min);
        uint64_t guest_end = req.has_end ? req.end : addr_max;
        if (guest_start < addr_min) guest_start = addr_min;
        if (guest_start > addr_max) guest_start = addr_max;
        if (guest_end < addr_min) guest_end = addr_min;
        if (guest_end > addr_max) guest_end = addr_max;

        hit_list_t hits = {NULL, 0, 0};
        if (task != MACH_PORT_NULL) {
            uint64_t t0 = monotonic_ms();
            if (guest_end > guest_start) {
                search_host_range(
                    task,
                    guest_base + guest_start,
                    guest_base + guest_end,
                    guest_base,
                    pat_bytes,
                    pat_mask,
                    pat_len,
                    anchor_idx,
                    max_hits,
                    &hits,
                    t0,
                    budget_ms,
                    scan_buf,
                    scan_buf_len);
            }
            if (!is_direct_host_va && hits.count == 0 && (is_heap || guest_start >= STANDARD_HEAP_THRESHOLD)) {
                bool already_covered = guest_start <= LONGSHOT_HEAP_BASE && guest_end >= LONGSHOT_HEAP_END;
                if (!already_covered) {
                    t0 = monotonic_ms();
                    search_host_range(
                        task,
                        GUEST_WINDOW_BASE + LONGSHOT_HEAP_BASE,
                        GUEST_WINDOW_BASE + LONGSHOT_HEAP_END,
                        GUEST_WINDOW_BASE,
                        pat_bytes,
                        pat_mask,
                        pat_len,
                        anchor_idx,
                        max_hits,
                        &hits,
                        t0,
                        budget_ms,
                        scan_buf,
                        scan_buf_len);
                }
            }
            release_task_port(&task);
        }

        size_t resp_cap = strlen(req.id_json) + 64 + (hits.count * 24);
        char *resp = (char *)malloc(resp_cap);
        if (resp) {
            size_t pos = 0;
            bool fmt_ok = true;
            int hdr = snprintf(resp, resp_cap, "{\"id\":%s,\"result\":{\"hits\":[", req.id_json);
            if (hdr < 0 || (size_t)hdr >= resp_cap) {
                fmt_ok = false;
            } else {
                pos = (size_t)hdr;
            }
            for (size_t i = 0; fmt_ok && i < hits.count; i++) {
                size_t rem = resp_cap - pos;
                int w = snprintf(resp + pos, rem, "%s\"0x%llx\"",
                    i > 0 ? "," : "", (unsigned long long)hits.items[i]);
                if (w < 0 || (size_t)w >= rem) {
                    fmt_ok = false;
                    break;
                }
                pos += (size_t)w;
            }
            if (fmt_ok) {
                size_t rem = resp_cap - pos;
                int tail = snprintf(resp + pos, rem, "]}}\n");
                if (tail < 0 || (size_t)tail >= rem) {
                    fmt_ok = false;
                } else {
                    pos += (size_t)tail;
                }
            }
            if (fmt_ok) {
                (void)send_all(fd, resp, pos);
            } else {
                send_json_error(fd, req.id_json, -32000, "Response overflow");
            }
            free(resp);
        } else {
            send_json_error(fd, req.id_json, -32000, "Out of memory");
        }

        free(hits.items);
        free(scan_buf);
        free(pat_bytes);
        free(pat_mask);
        rpc_request_free(&req);
        return true;
    }

    send_json_error(fd, req.id_json, -32601, "Method not found");
    rpc_request_free(&req);
    return true;
}

static void *client_thread_main(void *arg) {
    client_node_t *node = (client_node_t *)arg;
    int fd = node->fd;

    size_t cap = 4096;
    size_t len = 0;
    char *buf = (char *)malloc(cap);
    if (!buf) {
        goto cleanup;
    }

    bool first_line = true;
    bool close_client = false;

    while (!g_stop && !close_client) {
        struct pollfd pfd;
        pfd.fd = fd;
        pfd.events = POLLIN;
        pfd.revents = 0;

        int pr = poll(&pfd, 1, 250);
        if (pr < 0) {
            if (errno == EINTR) {
                continue;
            }
            break;
        }
        if (pr == 0) {
            continue;
        }
        if ((pfd.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0 && (pfd.revents & POLLIN) == 0) {
            break;
        }

        char chunk[4096];
        ssize_t n = recv(fd, chunk, sizeof(chunk), 0);
        if (n <= 0) {
            if (n < 0 && errno == EINTR) {
                continue;
            }
            break;
        }

        if (len + (size_t)n + 1 > cap) {
            size_t next_cap = cap * 2;
            while (next_cap < len + (size_t)n + 1) {
                next_cap *= 2;
            }
            if (next_cap > 1024 * 1024) {
                break;
            }
            char *grown = (char *)realloc(buf, next_cap);
            if (!grown) {
                break;
            }
            buf = grown;
            cap = next_cap;
        }

        memcpy(buf + len, chunk, (size_t)n);
        len += (size_t)n;
        buf[len] = '\0';

        char *start = buf;
        for (;;) {
            char *nl = (char *)memchr(start, '\n', len - (size_t)(start - buf));
            if (!nl) {
                break;
            }
            *nl = '\0';
            if (nl > start && *(nl - 1) == '\r') {
                *(nl - 1) = '\0';
            }
            const char *trimmed = skip_ws(start);
            if (*trimmed != '\0') {
                bool parsed_ok = handle_rpc_line(fd, trimmed);
                if (first_line && !parsed_ok) {
                    close_client = true;
                    break;
                }
                first_line = false;
            }
            start = nl + 1;
        }

        size_t rem = len - (size_t)(start - buf);
        if (rem > 0 && start != buf) {
            memmove(buf, start, rem);
        }
        len = rem;
        buf[len] = '\0';
    }

    free(buf);
cleanup:
    shutdown(fd, SHUT_RDWR);
    pthread_mutex_lock(&g_clients_mutex);
    node->finished = true;
    if (g_active_clients > 0) {
        g_active_clients--;
    }
    pthread_mutex_unlock(&g_clients_mutex);
    return NULL;
}

static void register_client(client_node_t *node) {
    pthread_mutex_lock(&g_clients_mutex);
    node->next = g_clients_head;
    g_clients_head = node;
    pthread_mutex_unlock(&g_clients_mutex);
}

static void reap_finished_clients(void) {
    client_node_t *reap_list = NULL;

    pthread_mutex_lock(&g_clients_mutex);
    client_node_t **pp = &g_clients_head;
    while (*pp) {
        client_node_t *cur = *pp;
        if (cur->finished) {
            *pp = cur->next;
            cur->next = reap_list;
            reap_list = cur;
        } else {
            pp = &cur->next;
        }
    }
    pthread_mutex_unlock(&g_clients_mutex);

    while (reap_list) {
        client_node_t *next = reap_list->next;
        pthread_join(reap_list->thread, NULL);
        if (reap_list->fd >= 0) {
            close(reap_list->fd);
            reap_list->fd = -1;
        }
        free(reap_list);
        reap_list = next;
    }
}

static void cleanup_clients(void) {
    pthread_mutex_lock(&g_clients_mutex);
    client_node_t *cur = g_clients_head;
    g_clients_head = NULL;
    pthread_mutex_unlock(&g_clients_mutex);

    while (cur) {
        client_node_t *next = cur->next;
        if (cur->fd >= 0) {
            shutdown(cur->fd, SHUT_RDWR);
        }
        pthread_join(cur->thread, NULL);
        if (cur->fd >= 0) {
            close(cur->fd);
            cur->fd = -1;
        }
        free(cur);
        cur = next;
    }
}

static int run_self_test(void) {
    rpc_request_t req;
    const char *sample = "{\"id\":42,\"method\":\"read_memory\",\"params\":{\"address\":\"0x80000000\",\"size\":8,\"as\":\"hex\"}}";
    if (!parse_rpc_request(sample, &req)) {
        fprintf(stderr, "self-test failed: parse_rpc_request\n");
        return 1;
    }
    bool ok = strcmp(req.id_json, "42") == 0 &&
              strcmp(req.method, "read_memory") == 0 &&
              req.has_address && req.address == 0x80000000ULL &&
              req.has_size && req.size == 8;
    rpc_request_free(&req);
    if (!ok) {
        fprintf(stderr, "self-test failed: read_memory field validation\n");
        return 1;
    }

    uint8_t *bytes = NULL;
    uint8_t *mask = NULL;
    size_t len = 0;
    if (!parse_hex_pattern("4d 4f ?? 30", &bytes, &mask, &len) || len != 4 ||
        bytes[0] != 0x4D || mask[0] != 1 || mask[2] != 0 || bytes[3] != 0x30) {
        free(bytes);
        free(mask);
        fprintf(stderr, "self-test failed: parse_hex_pattern\n");
        return 1;
    }
    free(bytes);
    free(mask);

    region_list_t regions;
    if (!collect_readable_regions_task(mach_task_self(), 0ULL, UINT64_MAX, &regions) || regions.count == 0) {
        free(regions.items);
        fprintf(stderr, "self-test failed: mach_vm_region self enumeration\n");
        return 1;
    }
    free(regions.items);

    rpc_request_t bad_req;
    if (parse_rpc_request("{\"id\":1,\"method\":\"status\",\"params\":{\"size\":-inf}}", &bad_req)) {
        rpc_request_free(&bad_req);
        fprintf(stderr, "self-test failed: -inf should be rejected\n");
        return 1;
    }
    if (parse_rpc_request("{\"id\":1,\"method\":\"status\",\"params\":{\"size\":-nan}}", &bad_req)) {
        rpc_request_free(&bad_req);
        fprintf(stderr, "self-test failed: -nan should be rejected\n");
        return 1;
    }
    if (parse_rpc_request("{\"id\":1,\"method\":\"status\",\"params\":{\"size\":0x1.0p0}}", &bad_req)) {
        rpc_request_free(&bad_req);
        fprintf(stderr, "self-test failed: hex float should be rejected\n");
        return 1;
    }
    if (parse_rpc_request("{\"id\":1,\"method\":\"status\\u0000\"}", &bad_req)) {
        rpc_request_free(&bad_req);
        fprintf(stderr, "self-test failed: \\u0000 should be rejected\n");
        return 1;
    }

    target_state_t found;
    if (discover_target(&found, false)) {
        printf("SELF_TEST_OK target_pid=%ld emulator=%s save_dir=%s task_for_pid=%s\n",
            (long)found.pid,
            found.emulator,
            found.has_save_dir ? found.save_dir : "",
            found.task_access_denied ? "denied" : "ok");
    } else {
        printf("SELF_TEST_OK target_pid=none\n");
    }
    return 0;
}

static bool parse_strict_positive_long(const char *s, long min_val, long max_val, long *out) {
    if (!s || !isdigit((unsigned char)*s)) {
        return false;
    }
    errno = 0;
    char *endp = NULL;
    long v = strtol(s, &endp, 10);
    if (errno != 0 || endp == s || *endp != '\0' || v < min_val || v > max_val) {
        return false;
    }
    *out = v;
    return true;
}

static void print_usage(const char *prog) {
    printf(
        "Usage: %s [options]\n"
        "Strictly read-only macOS memory JSON-RPC bridge for Longshot / Project ReLink / Triforce.\n\n"
        "Options:\n"
        "  --port <port>       Listen port on 127.0.0.1 (default: %d)\n"
        "  --pid <pid>         Attach to a specific target PID directly\n"
        "  --watch             Stay running and attach/re-attach as processes start/stop (default)\n"
        "  --once              Require a running target at startup and exit when it exits\n"
        "  --print-save-dir    Resolve <game_root>/user from running target and print it\n"
        "  --detect            Print detected target PID, emulator, and save dir\n"
        "  --self-test         Run built-in parser and Mach VM self-checks and exit\n"
        "  --help              Show this help message\n",
        prog, DEFAULT_BRIDGE_PORT);
}

int main(int argc, char **argv) {
    int port = DEFAULT_BRIDGE_PORT;
    bool print_save_dir = false;
    bool detect_only = false;
    bool self_test = false;

    for (int i = 1; i < argc; i++) {
        const char *arg = argv[i];
        if (strcmp(arg, "--help") == 0 || strcmp(arg, "-h") == 0) {
            print_usage(argv[0]);
            return 0;
        } else if (strcmp(arg, "--port") == 0 && i + 1 < argc) {
            long p = 0;
            if (!parse_strict_positive_long(argv[++i], 1L, 65535L, &p)) {
                fprintf(stderr, "Invalid port: %s\n", argv[i]);
                return 2;
            }
            port = (int)p;
        } else if (strcmp(arg, "--pid") == 0 && i + 1 < argc) {
            long p = 0;
            if (!parse_strict_positive_long(argv[++i], 1L, (long)INT_MAX, &p)) {
                fprintf(stderr, "Invalid pid: %s\n", argv[i]);
                return 2;
            }
            g_forced_pid = (pid_t)p;
        } else if (strcmp(arg, "--watch") == 0) {
            g_once_mode = false;
        } else if (strcmp(arg, "--once") == 0) {
            g_once_mode = true;
        } else if (strcmp(arg, "--print-save-dir") == 0) {
            print_save_dir = true;
        } else if (strcmp(arg, "--detect") == 0) {
            detect_only = true;
        } else if (strcmp(arg, "--self-test") == 0) {
            self_test = true;
        } else {
            fprintf(stderr, "Unknown argument: %s\n", arg);
            print_usage(argv[0]);
            return 2;
        }
    }

    if (self_test) {
        return run_self_test();
    }

    if (print_save_dir || detect_only) {
        target_state_t found;
        if (!discover_target(&found, false)) {
            return 1;
        }
        if (print_save_dir) {
            if (!found.has_save_dir) {
                return 1;
            }
            printf("%s\n", found.save_dir);
        } else {
            if (found.task_access_denied) {
                printf("PID=%ld\nEMULATOR=%s\nSAVE_DIR=%s\nTASK_FOR_PID=denied (%s, kr=%d)\n",
                    (long)found.pid,
                    found.emulator,
                    found.has_save_dir ? found.save_dir : "",
                    mach_error_string(found.task_kr),
                    (int)found.task_kr);
            } else {
                printf("PID=%ld\nEMULATOR=%s\nSAVE_DIR=%s\nTASK_FOR_PID=ok\n",
                    (long)found.pid,
                    found.emulator,
                    found.has_save_dir ? found.save_dir : "");
            }
        }
        return 0;
    }

    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = on_signal;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);

    if (g_once_mode) {
        pthread_mutex_lock(&g_target_mutex);
        bool ok = refresh_target_locked(true);
        pthread_mutex_unlock(&g_target_mutex);
        if (!ok) {
            fprintf(stderr, "[longshot-rpc-bridge] No running Longshot/ReLink/Triforce process with 0x100080000000 mapping found.\n");
            return 2;
        }
    } else {
        pthread_mutex_lock(&g_target_mutex);
        (void)refresh_target_locked(true);
        pthread_mutex_unlock(&g_target_mutex);
    }

    int listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd < 0) {
        perror("socket");
        pthread_mutex_lock(&g_target_mutex);
        release_task_port(&g_target.task);
        pthread_mutex_unlock(&g_target_mutex);
        return 1;
    }
    (void)fcntl(listen_fd, F_SETFD, FD_CLOEXEC);

    int opt_one = 1;
    (void)setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt_one, sizeof(opt_one));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    if (bind(listen_fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        perror("bind 127.0.0.1");
        close(listen_fd);
        pthread_mutex_lock(&g_target_mutex);
        release_task_port(&g_target.task);
        pthread_mutex_unlock(&g_target_mutex);
        return 1;
    }

    if (listen(listen_fd, 16) != 0) {
        perror("listen");
        close(listen_fd);
        pthread_mutex_lock(&g_target_mutex);
        release_task_port(&g_target.task);
        pthread_mutex_unlock(&g_target_mutex);
        return 1;
    }

    printf("BRIDGE_READY 127.0.0.1:%d\n", port);
    fflush(stdout);

    uint64_t last_target_check = monotonic_ms();
    while (!g_stop) {
        struct pollfd pfd;
        pfd.fd = listen_fd;
        pfd.events = POLLIN;
        pfd.revents = 0;

        int pr = poll(&pfd, 1, 250);
        if (pr < 0) {
            if (errno == EINTR) {
                continue;
            }
            break;
        }

        uint64_t now = monotonic_ms();
        if (now - last_target_check >= 1000ULL) {
            last_target_check = now;
            reap_finished_clients();
            pthread_mutex_lock(&g_target_mutex);
            (void)refresh_target_locked(false);
            pthread_mutex_unlock(&g_target_mutex);
            if (g_stop) {
                break;
            }
        }

        if (pr == 0 || (pfd.revents & POLLIN) == 0) {
            continue;
        }

        int client_fd = accept(listen_fd, NULL, NULL);
        if (client_fd < 0) {
            if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) {
                continue;
            }
            break;
        }
        (void)fcntl(client_fd, F_SETFD, FD_CLOEXEC);

        reap_finished_clients();

        pthread_mutex_lock(&g_clients_mutex);
        if (g_active_clients >= MAX_RPC_CLIENTS) {
            pthread_mutex_unlock(&g_clients_mutex);
            close(client_fd);
            continue;
        }
        g_active_clients++;
        pthread_mutex_unlock(&g_clients_mutex);

        int nodelay = 1;
        (void)setsockopt(client_fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));
#ifdef SO_NOSIGPIPE
        int nosigpipe = 1;
        (void)setsockopt(client_fd, SOL_SOCKET, SO_NOSIGPIPE, &nosigpipe, sizeof(nosigpipe));
#endif

        client_node_t *node = (client_node_t *)calloc(1, sizeof(client_node_t));
        if (!node) {
            pthread_mutex_lock(&g_clients_mutex);
            if (g_active_clients > 0) {
                g_active_clients--;
            }
            pthread_mutex_unlock(&g_clients_mutex);
            close(client_fd);
            continue;
        }
        node->fd = client_fd;

        if (pthread_create(&node->thread, NULL, client_thread_main, node) != 0) {
            pthread_mutex_lock(&g_clients_mutex);
            if (g_active_clients > 0) {
                g_active_clients--;
            }
            pthread_mutex_unlock(&g_clients_mutex);
            close(client_fd);
            free(node);
            continue;
        }
        register_client(node);
    }

    close(listen_fd);
    cleanup_clients();
    pthread_mutex_lock(&g_target_mutex);
    release_task_port(&g_target.task);
    pthread_mutex_unlock(&g_target_mutex);
    return 0;
}
