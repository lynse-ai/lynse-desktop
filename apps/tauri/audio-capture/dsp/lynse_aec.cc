#include "lynse_aec.h"

#include <api/scoped_refptr.h>
#include <modules/audio_processing/include/audio_processing.h>

#include <algorithm>
#include <memory>

namespace {

constexpr size_t kChannels = 1;

bool is_supported_rate(int rate) {
    return rate == 16000 || rate == 32000 || rate == 48000;
}

webrtc::StreamConfig config_for(int rate) {
    return webrtc::StreamConfig(rate, kChannels);
}

rtc::scoped_refptr<webrtc::AudioProcessing> create_apm() {
    rtc::scoped_refptr<webrtc::AudioProcessing> apm = webrtc::AudioProcessingBuilder().Create();
    if (apm == nullptr) return nullptr;
    webrtc::AudioProcessing::Config config;
    // Only the echo canceller runs: no AGC, no extra noise suppression and no
    // separate high-pass stage, so the microphone signal keeps its level and
    // timbre and quiet near-end speech is not damaged.
    config.echo_canceller.enabled = true;
    config.echo_canceller.mobile_mode = false;
    config.echo_canceller.export_linear_aec_output = false;
    config.gain_controller1.enabled = false;
    config.gain_controller2.enabled = false;
    config.noise_suppression.enabled = false;
    config.high_pass_filter.enabled = false;
    apm->ApplyConfig(config);
    return apm;
}

}  // namespace

struct lynse_aec {
    rtc::scoped_refptr<webrtc::AudioProcessing> apm;
    webrtc::StreamConfig stream_config;
    int sample_rate = 0;
    int frame_samples = 0;
    float *reverse_buffer = nullptr;
    float *near_buffer = nullptr;

    ~lynse_aec() {
        delete[] reverse_buffer;
        delete[] near_buffer;
    }
};

lynse_aec_t *lynse_aec_create(int sample_rate_hz) {
    if (!is_supported_rate(sample_rate_hz)) return nullptr;
    rtc::scoped_refptr<webrtc::AudioProcessing> apm = create_apm();
    if (apm == nullptr) return nullptr;

    lynse_aec *aec = new (std::nothrow) lynse_aec();
    if (aec == nullptr) return nullptr;
    aec->sample_rate = sample_rate_hz;
    aec->frame_samples = sample_rate_hz / 100;  // 10 ms
    aec->stream_config = config_for(sample_rate_hz);
    aec->reverse_buffer = new (std::nothrow) float[aec->frame_samples]();
    aec->near_buffer = new (std::nothrow) float[aec->frame_samples]();
    if (aec->reverse_buffer == nullptr || aec->near_buffer == nullptr) {
        delete aec;
        return nullptr;
    }
    aec->apm = std::move(apm);
    return aec;
}

void lynse_aec_destroy(lynse_aec_t *aec) { delete aec; }

const char *lynse_aec_engine_id(void) { return "webrtc-aec3-1.3"; }

int lynse_aec_process_reverse(lynse_aec_t *aec, const float *samples, int frame_count) {
    if (aec == nullptr || samples == nullptr || frame_count != aec->frame_samples) return -1;
    std::copy(samples, samples + frame_count, aec->reverse_buffer);
    float *channel[1] = {aec->reverse_buffer};
    const webrtc::StreamConfig &config = aec->stream_config;
    return aec->apm->ProcessReverseStream(channel, config, config, channel) == webrtc::AudioProcessing::kNoError
               ? 0
               : -2;
}

int lynse_aec_process_near(lynse_aec_t *aec, float *samples, int frame_count, int delay_ms) {
    if (aec == nullptr || samples == nullptr || frame_count != aec->frame_samples) return -1;
    if (aec->apm->set_stream_delay_ms(delay_ms) != webrtc::AudioProcessing::kNoError) return -3;
    std::copy(samples, samples + frame_count, aec->near_buffer);
    float *channel[1] = {aec->near_buffer};
    const webrtc::StreamConfig &config = aec->stream_config;
    int result = aec->apm->ProcessStream(channel, config, config, channel);
    if (result != webrtc::AudioProcessing::kNoError) return -2;
    std::copy(aec->near_buffer, aec->near_buffer + frame_count, samples);
    return 0;
}

void lynse_aec_reset(lynse_aec_t *aec) {
    if (aec == nullptr) return;
    // APM has no public reset; swapping in a fresh instance is the canonical
    // way (mirrors what PulseAudio does on stream changes) and is cheap
    // enough for the rare device-switch path.
    rtc::scoped_refptr<webrtc::AudioProcessing> fresh = create_apm();
    if (fresh == nullptr) return;
    aec->apm = std::move(fresh);
}
