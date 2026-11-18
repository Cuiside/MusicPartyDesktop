/* Per-window Windows acrylic tint. Does not modify system settings.
 * Usage: lyrics-glass.exe <HWND-decimal> <owner-pid> <opacity-0..100> [radius]
 * The HWND owner must match the calling Electron process. */
#include <windows.h>
#include <stdlib.h>
#include <stdint.h>

typedef struct { int state; int flags; unsigned int color; int animation; } AccentPolicy;
typedef struct { int attribute; void *data; size_t size; } CompositionData;
typedef BOOL (WINAPI *SetComposition)(HWND, CompositionData *);

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR args, int show) {
    (void)instance; (void)previous; (void)show;
    char *end = NULL;
    unsigned long long handle = _strtoui64(args, &end, 10);
    if (!handle || end == args) return 2;
    char *next = end;
    unsigned long owner = strtoul(next, &end, 10);
    if (end == next || owner == 0) return 2;
    next = end;
    long opacity = strtol(next, &end, 10);
    if (end == next || opacity < -1 || opacity > 100) return 2;
    next = end;
    long radius = 0;
    if (*next != '\0') {
        radius = strtol(next, &end, 10);
        if (end == next || radius < 0 || radius > 64) return 2;
    }
    HWND hwnd = (HWND)(uintptr_t)handle;
    DWORD actual = 0;
    if (!IsWindow(hwnd) || !GetWindowThreadProcessId(hwnd, &actual) || actual != owner) return 3;
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    SetComposition apply = (SetComposition)GetProcAddress(user32, "SetWindowCompositionAttribute");
    if (!apply) return 4;
    /* 0..99 always enables acrylic. The Electron backdrop window controls
       transparency continuously with SetOpacity; switching AccentPolicy modes
       for each slider value causes a visible 0 -> 1 material discontinuity.
       100 and -1 clear the native effect completely. */
    int mode = (opacity < 0 || opacity >= 100) ? 0 : 4;
    unsigned int alpha = mode == 4 ? 1 : 0;
    AccentPolicy policy = { mode, 2, (alpha << 24) | 0x00f3f2f1, 0 };
    CompositionData data = { 19, &policy, sizeof(policy) };
    if (!apply(hwnd, &data)) return 5;
    if (radius > 0) {
        RECT client = {0};
        if (!GetClientRect(hwnd, &client)) return 6;
        int width = client.right - client.left;
        int height = client.bottom - client.top;
        if (width <= 0 || height <= 0) return 6;
        HRGN region = CreateRoundRectRgn(0, 0, width + 1, height + 1, (int)radius * 2, (int)radius * 2);
        if (!region || SetWindowRgn(hwnd, region, TRUE) == 0) {
            if (region) DeleteObject(region);
            return 6;
        }
        HMODULE dwm = LoadLibraryW(L"dwmapi.dll");
        if (dwm) {
            typedef long (WINAPI *DwmSetWindowAttributeFn)(HWND, DWORD, LPCVOID, DWORD);
            DwmSetWindowAttributeFn setAttribute = (DwmSetWindowAttributeFn)GetProcAddress(dwm, "DwmSetWindowAttribute");
            if (setAttribute) {
                DWORD preference = 2;
                setAttribute(hwnd, 33, &preference, sizeof(preference));
            }
            FreeLibrary(dwm);
        }
    }
    return 0;
}
