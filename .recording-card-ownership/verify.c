typedef __SIZE_TYPE__ size_t;
typedef unsigned char byte;

enum { field_limit = 128, input_limit = 4 * (field_limit + 1) };

struct field {
    const byte *bytes;
    size_t length;
};

static int parse_fields(const byte *input, size_t length, struct field fields[4]) {
    size_t start = 0;
    size_t index = 0;
    for (size_t end = 0; end < length; ++end) {
        if (input[end] == 0) {
            if (index == 4 || end - start > field_limit) {
                return 0;
            }
            fields[index].bytes = input + start;
            fields[index].length = end - start;
            start = end + 1;
            ++index;
        } else if (input[end] < 33 || input[end] > 126) {
            return 0;
        }
    }
    return index == 4 && start == length;
}

static int hex_digit(byte value) {
    if (value >= '0' && value <= '9') {
        return value - '0';
    }
    value |= 32;
    if (value >= 'a' && value <= 'f') {
        return value - 'a' + 10;
    }
    return -1;
}

static int parse_mac(struct field field, byte mac[6]) {
    size_t stride = field.length == 17 ? 3 : 2;
    if (field.length != 6 * stride - (stride == 3)) {
        return 0;
    }
    byte separator = stride == 3 ? field.bytes[2] : 0;
    if (stride == 3 && separator != ':' && separator != '-') {
        return 0;
    }
    byte any = 0;
    byte all = 255;
    for (size_t i = 0; i < 6; ++i) {
        size_t offset = stride * i;
        int high = hex_digit(field.bytes[offset]);
        int low = hex_digit(field.bytes[offset + 1]);
        if (high < 0 || low < 0 || (stride == 3 && i < 5 && field.bytes[offset + 2] != separator)) {
            return 0;
        }
        mac[i] = (byte)(16 * high + low);
        any |= mac[i];
        all &= mac[i];
    }
    return any != 0 && all != 255;
}

static int equal_bytes(const byte *first, const byte *second, size_t length) {
    for (size_t i = 0; i < length; ++i) {
        if (first[i] != second[i]) {
            return 0;
        }
    }
    return 1;
}

__attribute__((visibility("default")))
int rc_owner_match_v1(const byte *input, size_t length, int bind_status) {
    if (input == 0 || length > input_limit || bind_status != 1) {
        return 0;
    }
    struct field fields[4];
    byte device_mac[6];
    byte account_mac[6];
    if (!parse_fields(input, length, fields) || fields[0].length == 0 ||
        !parse_mac(fields[1], device_mac) || !parse_mac(fields[3], account_mac) ||
        !equal_bytes(device_mac, account_mac, 6)) {
        return 0;
    }
    return fields[2].length == 0 ||
        (fields[0].length == fields[2].length &&
         equal_bytes(fields[0].bytes, fields[2].bytes, fields[0].length));
}

#if defined(__wasm__)
static byte input_buffer[input_limit];

__attribute__((visibility("default")))
byte *rc_owner_input_v1(void) {
    return input_buffer;
}
#endif
