#include "engine/framework/audio/chunking.h"
#include "engine/models/qwen3_asr/types.h"
#include "engine/models/seed_vc/length_regulator.h"
#include "test_assert.h"

#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

template <typename Function>
void require_rejected(Function function, const std::string & label) {
    bool rejected = false;
    try {
        function();
    } catch (const std::runtime_error &) {
        rejected = true;
    }
    engine::test::require(rejected, label);
}

void test_qwen_timestamp_input_timebase() {
    using engine::models::qwen3_asr::qwen3_asr_rescale_word_timestamps;
    std::vector<engine::runtime::WordTimestamp> original = {{{61440, 71680}, "voice", 0.9F}};
    auto at_48k = original;
    qwen3_asr_rescale_word_timestamps(at_48k, 16000, 48000);
    engine::test::require_eq(at_48k.front().span.start_sample, int64_t{184320}, "48k start");
    engine::test::require_eq(at_48k.front().span.end_sample, int64_t{215040}, "48k end");
    engine::test::require_eq(at_48k.front().word, original.front().word, "word is unchanged");
    engine::test::require(at_48k.front().confidence == original.front().confidence, "confidence is unchanged");
    engine::test::require(
        at_48k.front().span.start_sample / 48000.0 == original.front().span.start_sample / 16000.0,
        "equal source audio must give the same seconds at 16k and 48k");

    auto at_44100 = original;
    qwen3_asr_rescale_word_timestamps(at_44100, 16000, 44100);
    engine::test::require_eq(at_44100.front().span.start_sample, int64_t{169344}, "44.1k start");
    engine::test::require_eq(at_44100.front().span.end_sample, int64_t{197568}, "44.1k end");
    qwen3_asr_rescale_word_timestamps(original, 16000, 16000);
    engine::test::require_eq(original.front().span.end_sample, int64_t{71680}, "16k identity");
}

void test_qwen_chunk_offset_converted_once() {
    std::vector<engine::runtime::WordTimestamp> words;
    engine::audio::append_chunk_word_timestamps(
        words, {{{1600, 3200}, "chunk", 1.0F}}, {96000, 192000}, {96000, 192000}, 48000, 16000);
    engine::test::require_eq(words.front().span.start_sample, int64_t{33600}, "model-rate chunk offset");
    engine::models::qwen3_asr::qwen3_asr_rescale_word_timestamps(words, 16000, 48000);
    engine::test::require_eq(words.front().span.start_sample, int64_t{100800}, "input-rate chunk offset once");
    engine::test::require_eq(words.front().span.end_sample, int64_t{105600}, "input-rate chunk end once");
}

void test_qwen_timestamp_rounding_and_bounds() {
    using engine::models::qwen3_asr::qwen3_asr_rescale_word_timestamps;
    std::vector<engine::runtime::WordTimestamp> words = {{{-1, 1}, "unclamped", 0.0F}};
    qwen3_asr_rescale_word_timestamps(words, 16000, 44100);
    engine::test::require_eq(words.front().span.start_sample, int64_t{-3}, "negative time is not clamped");
    engine::test::require_eq(words.front().span.end_sample, int64_t{3}, "round to nearest sample");
    require_rejected([&] { qwen3_asr_rescale_word_timestamps(words, 0, 48000); }, "invalid source rate");
    require_rejected([&] { qwen3_asr_rescale_word_timestamps(words, 16000, -1); }, "invalid target rate");
    words = {{{0, std::numeric_limits<int64_t>::max()}, "overflow", 0.0F}};
    require_rejected([&] { qwen3_asr_rescale_word_timestamps(words, 1, 2); }, "timestamp overflow");
    words = {{{std::numeric_limits<int64_t>::min(), 0}, "underflow", 0.0F}};
    require_rejected([&] { qwen3_asr_rescale_word_timestamps(words, 1, 2); }, "timestamp underflow");
}

void test_seed_source_length_adjustment() {
    using engine::models::seed_vc::seed_vc_adjusted_source_frames;
    engine::test::require_eq(seed_vc_adjusted_source_frames(200, 1.0F), int64_t{200}, "default preserves source");
    engine::test::require_eq(seed_vc_adjusted_source_frames(200, 1.5F), int64_t{300}, "lengthen source");
    engine::test::require_eq(seed_vc_adjusted_source_frames(200, 0.5F), int64_t{100}, "shorten source");
    engine::test::require_eq(seed_vc_adjusted_source_frames(200, 1.05F), int64_t{209}, "v1 float truncation");
    engine::test::require_eq(seed_vc_adjusted_source_frames(1, 0.01F), int64_t{1}, "source stays non-empty");
    engine::test::require_eq(
        seed_vc_adjusted_source_frames(std::numeric_limits<int64_t>::max(), 1.0F),
        std::numeric_limits<int64_t>::max(), "default does not lose large integer precision");
    require_rejected([] { seed_vc_adjusted_source_frames(0, 1.0F); }, "empty source rejected");
    require_rejected([] { seed_vc_adjusted_source_frames(200, 0.0F); }, "zero factor rejected");
    require_rejected([] { seed_vc_adjusted_source_frames(200, -1.0F); }, "negative factor rejected");
    require_rejected([] { seed_vc_adjusted_source_frames(200, std::numeric_limits<float>::infinity()); }, "infinity rejected");
    require_rejected([] { seed_vc_adjusted_source_frames(200, std::numeric_limits<float>::quiet_NaN()); }, "NaN rejected");
    require_rejected([] { seed_vc_adjusted_source_frames(std::numeric_limits<int64_t>::max(), 2.0F); }, "frame overflow");
}

}  // namespace

int main() {
    try {
        test_qwen_timestamp_input_timebase();
        test_qwen_chunk_offset_converted_once();
        test_qwen_timestamp_rounding_and_bounds();
        test_seed_source_length_adjustment();
    } catch (const std::exception & error) {
        std::cerr << "model_request_math_test failed: " << error.what() << '\n';
        return 1;
    }
    std::cout << "model_request_math_test passed\n";
    return 0;
}
