/*
 * Thin C ABI over the vendored WebRTC AudioProcessing module (AEC3).
 *
 * The engine processes a single near-end (microphone) channel against a
 * mono far-end (system playback) reference at one fixed sample rate in
 * 10 ms frames. All higher-level buffering, resampling and timeline work
 * lives in Swift (AudioCaptureCore); this bridge only owns the APM instance.
 */
#ifndef LYNSE_AEC_H
#define LYNSE_AEC_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct lynse_aec lynse_aec_t;

/// Sample rates accepted by the engine.
/// Returns NULL when the sample rate is unsupported or initialization fails.
lynse_aec_t *lynse_aec_create(int sample_rate_hz);

void lynse_aec_destroy(lynse_aec_t *aec);

/// Known-good engine build identifier ("webrtc-aec3-1.3"); useful for
/// recording manifests. Never NULL.
const char *lynse_aec_engine_id(void);

/// Feed the 10 ms far-end (system playback) reference frame.
/// `samples` holds `frame_count` mono float samples in [-1, 1].
/// Returns 0 on success, negative on API misuse.
int lynse_aec_process_reverse(lynse_aec_t *aec, const float *samples, int frame_count);

/// Process one 10 ms near-end (microphone) frame in place.
/// `samples` holds `frame_count` mono float samples; the echo-cancelled
/// signal replaces the contents. `delay_ms` is the caller's estimate of the
/// acoustic path delay between the reference and the microphone capture.
/// Returns 0 on success, negative on API misuse.
int lynse_aec_process_near(lynse_aec_t *aec, float *samples, int frame_count, int delay_ms);

/// Drop all learned state (echo path estimate, delay alignment). Use after a
/// capture restart or device switch.
void lynse_aec_reset(lynse_aec_t *aec);

#ifdef __cplusplus
}
#endif

#endif /* LYNSE_AEC_H */
