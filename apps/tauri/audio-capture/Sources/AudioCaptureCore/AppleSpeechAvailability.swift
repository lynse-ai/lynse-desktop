/// Runtime gate usable without importing Speech at the call site. Split into
/// its own file: declarations inside the compiler-version conditional in
/// AppleSpeechRecognizer.swift were masked from clients compiling at a lower
/// deployment target (reported as "cannot find" instead of an availability
/// error) — an availability-erased entry point must live unconditionally.
public enum AppleSpeechAvailability {
    public static func isSupported() -> Bool {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) { return true }
        #endif
        return false
    }
}
