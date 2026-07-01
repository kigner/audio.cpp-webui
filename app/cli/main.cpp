#include "args.h"
#include "batch.h"
#include "request.h"
#include "../workflow/execution.h"
#include "../workflow/file_sink.h"
#include "../workflow/pipeline.h"
#include "../workflow/workflow.h"

#include "engine/framework/audio/conversion.h"
#include "engine/framework/debug/trace.h"
#include "engine/framework/runtime/registry.h"

#include <algorithm>
#include <cstddef>
#include <filesystem>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#ifdef _OPENMP
#include <omp.h>
#endif

namespace {

void print_task_list_help() {
    std::cout
        << "audiocpp_cli --task <task> --family <family> --model <path> --backend <backend> [options]\n"
        << "  Global:\n"
        << "    --task vad|asr|diar|sep|gen|tts|clon|vc|s2s|align|vdes|spk|svc\n"
        << "    --family <name>\n"
        << "    --model <path>\n"
        << "    --backend cpu|cuda|vulkan|metal|best\n"
        << "    --mode offline|streaming  default offline\n"
        << "    --device <n>\n"
        << "    --threads <n>  Backend and OpenMP worker threads, default 1\n"
        << "    --registry-config <path>\n"
        << "    --config <id>\n"
        << "    --weight <id>\n"
        << "    --log  Stream framework progress and timing logs to stdout\n"
        << "    --log-file <path>  Stream framework progress and timing logs to a file\n"
        << "    --load-option key=value\n"
        << "    --session-option key=value\n"
        << "    --request-option key=value\n"
        << "  Batch:\n"
        << "    --request-sequence <json>  Run JSON requests in one offline session\n"
        << "    --batch-text-file <txt>  Run one offline request per non-empty line\n"
        << "    --batch-audio-dir <dir>  Run one offline request per .wav file\n"
        << "    --batch-audio-role audio|voice_ref|source_audio|target_voice|prosody_ref|style_ref\n"
        << "    --batch-merge-audio none|concat\n"
        << "    --batch-manifest-out <json>\n"
        << "    Shared CLI inputs and options are defaults for --batch-text-file and --batch-audio-dir\n"
        << "  Pipelines:\n"
        << "    --pipeline <json>  Run a JSON app workflow instead of a raw task\n"
        << "    --list-pipelines\n"
        << "    --workflow-input key=value  Override a top-level workflow input\n"
        << "    --audio-converter <cmd>  Converter executable for workflow media import, default ffmpeg\n"
        << "  Task routing and media roles:\n"
        << "    --task-route <name>  User-facing route, e.g. text2music, zero_shot_tts, style_preserved_vc\n"
        << "    --source-audio <wav>  Source audio path for models that take path-based source refs\n"
        << "    --target-voice <wav>  Target/timbre voice path for path-based voice conversion\n"
        << "    --prosody-ref <wav>\n"
        << "    --style-ref <wav>\n"
        << "    --target-text <text>\n"
        << "    --style-ref-text <text>\n"
        << "    --use-prosody-code true|false\n"
        << "    --predict-target-prosody true|false\n"
        << "    --use-pitch-shift true|false\n"
        << "    --source-shift-steps <n>\n"
        << "    --prosody-shift-steps <n>\n"
        << "    --style-shift-steps <n>\n"
        << "    --target-duration-seconds <float>\n"
        << "    --reference-duration-seconds <float>\n"
        << "    --lyrics <text>\n"
        << "    --track-name <name>\n"
        << "    --speaker <name>\n"
        << "    --duration-seconds <float>\n"
        << "    --repaint-start <float>\n"
        << "    --repaint-end <float>\n"
        << "    --repaint-mode <name>\n"
        << "    --repaint-strength <float>\n"
        << "  Common generation:\n"
        << "    --seed <n>\n"
        << "    --max-tokens <n>\n"
        << "    --max-steps <n>\n"
        << "    --temperature <float>\n"
        << "    --top-k <n>\n"
        << "    --top-p <float>\n"
        << "    --repetition-penalty <float>\n"
        << "    --do-sample true|false\n"
        << "    --guidance-scale <float>\n"
        << "    --num-inference-steps <n>\n"
        << "    --text-chunk-size <chars>\n"
        << "  Inputs:\n"
        << "    --audio <wav>\n"
        << "    --text <text>\n"
        << "    --max-text-length <chars>  Maximum input text length for models that enforce it\n"
        << "    --language <code>\n"
        << "    --voice-id <id>\n"
        << "    --voice-ref <wav>\n"
        << "    --reference-text <text>  Reference transcript for voice-clone models such as Qwen3 TTS\n"
        << "    --instruct <text>  Voice-design instruction for models such as Qwen3 TTS\n"
        << "    --style-language <code>\n"
        << "    --emotion <name>\n"
        << "    --speaking-rate <float>\n"
        << "    --pitch-shift <float>\n"
        << "    --energy-scale <float>\n"
        << "    --style-tag key=value\n"
        << "  Outputs:\n"
        << "    --out <wav>\n"
        << "    --out-dir <dir>  Write named multi-audio outputs or batch request outputs\n"
        << "    --segments-out <json>\n"
        << "    --turns-out <json>\n"
        << "    --words-out <json>\n"
        << "    --voice-state-out <safetensors>  Export PocketTTS voice state from --voice-ref\n"
        << "  Streaming:\n"
        << "    --chunk-size <samples>\n"
        << "  Utility:\n"
        << "    --inspect\n"
        << "    --list-loaders\n"
        << "\n"
        << "  Tasks:\n"
        << "    vad    voice activity detection\n"
        << "    asr    automatic speech recognition\n"
        << "    diar   speaker diarization\n"
        << "    sep    source separation\n"
        << "    gen    text/audio conditioned music or sound generation\n"
        << "    tts    text to speech\n"
        << "    clon   voice cloning\n"
        << "    vc     voice conversion\n"
        << "    s2s    speech to speech\n"
        << "    align  forced alignment\n"
        << "    vdes   voice design\n"
        << "    spk    speaker embedding/recognition\n"
        << "    svc    singing voice conversion\n";
}

void print_option_group(const char * title, const std::vector<engine::runtime::CliOptionInfo> & options) {
    if (options.empty()) {
        return;
    }
    std::cout << "  " << title << ":\n";
    for (const auto & option : options) {
        std::cout << "    " << option.name;
        if (!option.value_name.empty()) {
            std::cout << " <" << option.value_name << ">";
        }
        if (!option.description.empty()) {
            std::cout << "  " << option.description;
        }
        std::cout << "\n";
    }
}

bool model_supports_task(const engine::runtime::ModelInspection & inspection, engine::runtime::VoiceTaskKind task) {
    return std::any_of(
        inspection.capabilities.supported_tasks.begin(),
        inspection.capabilities.supported_tasks.end(),
        [&](const engine::runtime::TaskCapability & capability) {
            return capability.task == task;
        });
}

void print_model_common_options(const engine::runtime::ModelInspection & inspection) {
    std::cout << "  Available input options:\n";
    if (model_supports_task(inspection, engine::runtime::VoiceTaskKind::AudioGeneration)) {
        std::cout
            << "    --text <text>\n"
            << "    --audio <wav>\n"
            << "    --batch-text-file <txt>\n"
            << "    --language <code>\n"
            << "    --duration-seconds <float>\n"
            << "    --guidance-scale <float>\n"
            << "    --num-inference-steps <n>\n"
            << "    --seed <n>\n"
            << "    --max-tokens <n>\n"
            << "    --temperature <float>\n"
            << "    --top-k <n>\n"
            << "    --top-p <float>\n"
            << "    --do-sample true|false\n";
    }
    if (model_supports_task(inspection, engine::runtime::VoiceTaskKind::Tts) ||
        model_supports_task(inspection, engine::runtime::VoiceTaskKind::VoiceDesign) ||
        model_supports_task(inspection, engine::runtime::VoiceTaskKind::VoiceCloning)) {
        std::cout
            << "    --text <text>\n"
            << "    --batch-text-file <txt>\n"
            << "    --language <code>\n"
            << "    --voice-ref <wav>\n"
            << "    --voice-id <id>\n"
            << "    --reference-text <text>\n"
            << "    --instruct <text>\n"
            << "    --speaker <name>\n"
            << "    --seed <n>\n"
            << "    --max-tokens <n>\n"
            << "    --temperature <float>\n"
            << "    --top-k <n>\n"
            << "    --top-p <float>\n"
            << "    --repetition-penalty <float>\n"
            << "    --do-sample true|false\n";
    }
    if (model_supports_task(inspection, engine::runtime::VoiceTaskKind::VoiceConversion) ||
        model_supports_task(inspection, engine::runtime::VoiceTaskKind::SpeechToSpeech) ||
        model_supports_task(inspection, engine::runtime::VoiceTaskKind::Svc)) {
        std::cout
            << "    --audio <wav>\n"
            << "    --batch-audio-dir <dir>\n"
            << "    --voice-ref <wav>\n"
            << "    --task-route <name>\n"
            << "    --source-audio <wav>\n"
            << "    --target-voice <wav>\n"
            << "    --prosody-ref <wav>\n"
            << "    --style-ref <wav>\n"
            << "    --target-text <text>\n"
            << "    --style-ref-text <text>\n"
            << "    --use-prosody-code true|false\n"
            << "    --predict-target-prosody true|false\n"
            << "    --use-pitch-shift true|false\n"
            << "    --source-shift-steps <n>\n"
            << "    --prosody-shift-steps <n>\n"
            << "    --style-shift-steps <n>\n"
            << "    --target-duration-seconds <float>\n"
            << "    --reference-duration-seconds <float>\n"
            << "    --num-inference-steps <n>\n"
            << "    --text-chunk-size <chars>\n"
            << "    --seed <n>\n";
    }
    if (model_supports_task(inspection, engine::runtime::VoiceTaskKind::Asr) ||
        model_supports_task(inspection, engine::runtime::VoiceTaskKind::Vad) ||
        model_supports_task(inspection, engine::runtime::VoiceTaskKind::Diarization) ||
        model_supports_task(inspection, engine::runtime::VoiceTaskKind::SourceSeparation) ||
        model_supports_task(inspection, engine::runtime::VoiceTaskKind::SpeakerRecognition)) {
        std::cout
            << "    --audio <wav>\n"
            << "    --batch-audio-dir <dir>\n";
    }
    if (model_supports_task(inspection, engine::runtime::VoiceTaskKind::Alignment)) {
        std::cout
            << "    --audio <wav>\n"
            << "    --batch-audio-dir <dir>\n"
            << "    --text <text>\n"
            << "    --language <code>\n";
    }
}

void print_model_help(const engine::runtime::ModelInspection & inspection) {
    std::cout
        << "family=" << inspection.metadata.family << "\n"
        << "variant=" << inspection.metadata.variant << "\n"
        << "model_root=" << inspection.model_root.string() << "\n"
        << "description=" << inspection.metadata.description << "\n"
        << "  Supported tasks:\n";
    for (const auto & capability : inspection.capabilities.supported_tasks) {
        std::cout << "    --task " << engine::runtime::to_string(capability.task) << " --mode ";
        for (size_t i = 0; i < capability.modes.size(); ++i) {
            if (i != 0) {
                std::cout << "|";
            }
            std::cout << engine::runtime::to_string(capability.modes[i]);
        }
        std::cout << "\n";
    }
    print_model_common_options(inspection);
    print_option_group("Model request options", inspection.cli.request_options);
    print_option_group("Model session options", inspection.cli.session_options);
    print_option_group("Model load options", inspection.cli.load_options);
    std::cout << "  Common output options:\n"
              << "    --out <wav>\n"
              << "    --out-dir <dir>\n"
              << "    --segments-out <json>\n"
              << "    --turns-out <json>\n"
              << "    --words-out <json>\n";
}

void print_task_help(const engine::runtime::ModelRegistry & registry, const std::string & task_name) {
    const auto task = engine::runtime::parse_voice_task_kind(task_name);
    std::cout
        << "task=" << engine::runtime::to_string(task) << "\n"
        << "  Select a model to see model-owned options:\n"
        << "    audiocpp_cli --task " << engine::runtime::to_string(task)
            << " --family <family> --model <path> --backend <backend> --help\n"
        << "  Registered families:\n";
    for (const auto & family : registry.families()) {
        std::cout << "    " << family << "\n";
    }
}

void print_inspection(const engine::runtime::ModelInspection & inspection) {
    std::cout << "family=" << inspection.metadata.family << "\n";
    std::cout << "variant=" << inspection.metadata.variant << "\n";
    std::cout << "model_root=" << inspection.model_root.string() << "\n";
    std::cout << "supported_tasks=" << inspection.capabilities.supported_tasks.size() << "\n";
    for (const auto & capability : inspection.capabilities.supported_tasks) {
        std::cout << "task=" << engine::runtime::to_string(capability.task) << " modes=";
        for (size_t i = 0; i < capability.modes.size(); ++i) {
            if (i != 0) {
                std::cout << ",";
            }
            std::cout << engine::runtime::to_string(capability.modes[i]);
        }
        std::cout << "\n";
    }
    std::cout << "supports_speaker_reference=" << (inspection.capabilities.supports_speaker_reference ? "true" : "false") << "\n";
    std::cout << "supports_style_condition=" << (inspection.capabilities.supports_style_condition ? "true" : "false") << "\n";
    std::cout << "supports_timestamps=" << (inspection.capabilities.supports_timestamps ? "true" : "false") << "\n";
    std::cout << "languages=";
    for (size_t i = 0; i < inspection.capabilities.languages.size(); ++i) {
        if (i != 0) {
            std::cout << ",";
        }
        std::cout << inspection.capabilities.languages[i];
    }
    std::cout << "\n";
    std::cout << "configs=" << inspection.discovered_configs.size() << "\n";
    for (const auto & config : inspection.discovered_configs) {
        std::cout << "config=" << config.id << ":" << config.path.string() << "\n";
    }
    std::cout << "weights=" << inspection.discovered_weights.size() << "\n";
    for (const auto & weight : inspection.discovered_weights) {
        std::cout << "weight=" << weight.id << ":" << weight.path.string() << "\n";
    }
}

void run_streaming(
    int argc,
    char ** argv,
    engine::runtime::IStreamingVoiceTaskSession & streaming,
    engine::runtime::IVoiceTaskSession & session,
    engine::runtime::TaskRequest & request) {
    if (!request.audio_input.has_value()) {
        throw std::runtime_error("streaming mode requires --audio input");
    }
    if (request.audio_input->channels != 1) {
        const auto mono = engine::audio::mixdown_interleaved_to_mono_average(
            request.audio_input->samples,
            request.audio_input->channels);
        request.audio_input->samples = mono;
        request.audio_input->channels = 1;
    }
    const int chunk_size = minitts::cli::parse_int_arg(argc, argv, "--chunk-size", 512);
    streaming.reset();
    const auto & samples = request.audio_input->samples;
    for (size_t offset = 0; offset < samples.size(); offset += static_cast<size_t>(chunk_size)) {
        const size_t available = std::min(static_cast<size_t>(chunk_size), samples.size() - offset);
        std::vector<float> chunk(static_cast<size_t>(chunk_size), 0.0f);
        std::copy(
            samples.begin() + static_cast<ptrdiff_t>(offset),
            samples.begin() + static_cast<ptrdiff_t>(offset + available),
            chunk.begin());
        const auto event = streaming.process_audio_chunk({
            request.audio_input->sample_rate,
            1,
            static_cast<int64_t>(offset),
            std::move(chunk),
        });
        for (const auto & activity : event.voice_activity) {
            std::cout << "event=";
            switch (activity.kind) {
            case engine::runtime::VoiceActivityEvent::Kind::SpeechStart:
                std::cout << "speech_start";
                break;
            case engine::runtime::VoiceActivityEvent::Kind::SpeechEnd:
                std::cout << "speech_end";
                break;
            case engine::runtime::VoiceActivityEvent::Kind::SpeechSegment:
                std::cout << "speech_segment";
                break;
            }
            std::cout << " sample=" << activity.sample << " probability=" << activity.probability << "\n";
        }
    }
    const auto result = streaming.finalize();
    std::cout << "family=" << session.family() << "\n";
    std::cout << "task=" << engine::runtime::to_string(session.task_kind()) << "\n";
    std::cout << "mode=" << engine::runtime::to_string(session.run_mode()) << "\n";
    minitts::app::emit_task_result(
        result,
        minitts::cli::optional_path_arg(argc, argv, "--out"),
        minitts::cli::optional_path_arg(argc, argv, "--out-dir"),
        minitts::cli::optional_path_arg(argc, argv, "--out-dir"),
        minitts::cli::optional_path_arg(argc, argv, "--segments-out"),
        minitts::cli::optional_path_arg(argc, argv, "--turns-out"),
        minitts::cli::optional_path_arg(argc, argv, "--words-out"));
}

}  // namespace

int main(int argc, char ** argv) {
    try {
        using namespace minitts::cli;

        const auto log_file = find_arg(argc, argv, "--log-file");
        engine::debug::configure_logging(engine::debug::LoggingConfig{
            has_arg(argc, argv, "--log") || log_file.has_value(),
            log_file,
        });

        const auto registry_config = find_arg(argc, argv, "--registry-config");
        auto registry = engine::runtime::make_default_registry(
            registry_config ? std::optional<std::filesystem::path>(std::filesystem::path(*registry_config)) : std::nullopt);
        auto pipeline_registry = minitts::app::make_default_pipeline_registry();
        const bool help_requested = has_arg(argc, argv, "--help");
        if (has_arg(argc, argv, "--list-pipelines")) {
            const auto ids = pipeline_registry.ids();
            std::cout << "registered_pipelines=" << ids.size() << "\n";
            for (const auto & id : ids) {
                std::cout << id << "\n";
            }
            return 0;
        }
        if (has_arg(argc, argv, "--list-loaders")) {
            const auto families = registry.families();
            std::cout << "registered_loaders=" << registry.size() << "\n";
            for (const auto & family : families) {
                std::cout << family << "\n";
            }
            return 0;
        }

        const auto model_arg = find_arg(argc, argv, "--model");
        const auto pipeline_arg = find_arg(argc, argv, "--pipeline");
        if (pipeline_arg.has_value()) {
            const int threads = parse_int_arg(argc, argv, "--threads", 1);
            if (threads <= 0) {
                throw std::runtime_error("--threads must be positive");
            }
#ifdef _OPENMP
            omp_set_num_threads(threads);
#endif
            engine::core::BackendConfig backend;
            backend.type = parse_backend(find_arg(argc, argv, "--backend").value_or("cpu"));
            backend.device = parse_int_arg(argc, argv, "--device", 0);
            backend.threads = threads;
            minitts::app::run_json_workflow(
                registry,
                minitts::app::WorkflowRunOptions{
                    std::filesystem::path(*pipeline_arg),
                    optional_path_arg(argc, argv, "--out-dir").value_or(std::filesystem::path("workflow_outputs")),
                    backend,
                    optional_path_arg(argc, argv, "--out"),
                    collect_key_value_args(argc, argv, "--load-option"),
                    collect_key_value_args(argc, argv, "--session-option"),
                    collect_key_value_args(argc, argv, "--workflow-input"),
                    find_arg(argc, argv, "--audio-converter").value_or("ffmpeg"),
                });
            return 0;
        }
        if (help_requested && !model_arg.has_value()) {
            if (const auto task = find_arg(argc, argv, "--task")) {
                print_task_help(registry, *task);
            } else {
                print_task_list_help();
            }
            return 0;
        }
        if (!model_arg) {
            throw std::runtime_error("missing required --model argument");
        }

        engine::runtime::ModelLoadRequest load_request;
        load_request.model_path = std::filesystem::path(*model_arg);
        if (const auto family = find_arg(argc, argv, "--family")) {
            load_request.family_hint = *family;
        }
        if (const auto config = find_arg(argc, argv, "--config")) {
            load_request.config_id = *config;
        }
        if (const auto weight = find_arg(argc, argv, "--weight")) {
            load_request.weight_id = *weight;
        }
        load_request.options = collect_key_value_args(argc, argv, "--load-option");

        if (help_requested) {
            print_model_help(registry.inspect(load_request));
            return 0;
        }

        if (has_arg(argc, argv, "--inspect")) {
            print_inspection(registry.inspect(load_request));
            return 0;
        }

        const auto task_name = find_arg(argc, argv, "--task");
        if (!task_name.has_value()) {
            throw std::runtime_error("missing required --task argument");
        }
        const auto mode_name = find_arg(argc, argv, "--mode").value_or("offline");
        const engine::runtime::TaskSpec task_spec{
            engine::runtime::parse_voice_task_kind(*task_name),
            engine::runtime::parse_run_mode(mode_name),
        };

        engine::runtime::SessionOptions session_options;
        session_options.backend.type = parse_backend(find_arg(argc, argv, "--backend").value_or("cpu"));
        session_options.backend.device = parse_int_arg(argc, argv, "--device", 0);
        const int threads = parse_int_arg(argc, argv, "--threads", 1);
        if (threads <= 0) {
            throw std::runtime_error("--threads must be positive");
        }
        session_options.backend.threads = threads;
#ifdef _OPENMP
        omp_set_num_threads(threads);
#endif
        session_options.options = collect_key_value_args(argc, argv, "--session-option");
        auto model = registry.load(load_request);
        auto session = model->create_task_session(task_spec, session_options);
        const auto voice_state_out = optional_path_arg(argc, argv, "--voice-state-out");

        if (has_batch_input(argc, argv)) {
            if (task_spec.mode != engine::runtime::RunMode::Offline) {
                throw std::runtime_error("batch inputs require offline mode");
            }
            if (voice_state_out.has_value()) {
                throw std::runtime_error("--voice-state-out is not supported with batch inputs");
            }
            const auto merge_mode = minitts::app::parse_audio_merge_mode(
                find_arg(argc, argv, "--batch-merge-audio").value_or("none"));
            if (optional_path_arg(argc, argv, "--out").has_value() &&
                merge_mode == minitts::app::AudioMergeMode::None) {
                throw std::runtime_error("batch --out requires --batch-merge-audio concat");
            }
            auto * offline = dynamic_cast<engine::runtime::IOfflineVoiceTaskSession *>(session.get());
            if (offline == nullptr) {
                throw std::runtime_error("selected task session does not support offline execution");
            }
            const engine::runtime::TaskRequest base_request =
                optional_path_arg(argc, argv, "--request-sequence").has_value()
                    ? engine::runtime::TaskRequest{}
                    : build_request_from_cli(argc, argv);
            const auto batch_request = build_batch_request_from_cli(argc, argv, base_request);
            const auto batch_result = minitts::app::run_offline_batch(
                *session,
                *offline,
                batch_request,
                merge_mode);
            std::cout << "family=" << session->family() << "\n";
            std::cout << "task=" << engine::runtime::to_string(session->task_kind()) << "\n";
            std::cout << "mode=" << engine::runtime::to_string(session->run_mode()) << "\n";
            minitts::app::emit_batch_result(
                batch_result,
                minitts::app::FileOutputPolicy{
                    optional_path_arg(argc, argv, "--out"),
                    optional_path_arg(argc, argv, "--out-dir"),
                    optional_path_arg(argc, argv, "--segments-out"),
                    optional_path_arg(argc, argv, "--turns-out"),
                    optional_path_arg(argc, argv, "--words-out"),
                    optional_path_arg(argc, argv, "--batch-manifest-out"),
                });
            return 0;
        }

        auto request = build_request_from_cli(argc, argv);
        if (voice_state_out.has_value()) {
            if (session->family() != "pocket_tts") {
                throw std::runtime_error("--voice-state-out is only supported by PocketTTS");
            }
            if (task_spec.task != engine::runtime::VoiceTaskKind::Tts) {
                throw std::runtime_error("--voice-state-out requires --task tts");
            }
            request.options["pocket_tts.export_voice_state_path"] = voice_state_out->string();
        }
        session->prepare(engine::runtime::build_preparation_request(request));
        if (voice_state_out.has_value()) {
            std::cout << "family=" << session->family() << "\n";
            std::cout << "voice_state_out=" << voice_state_out->string() << "\n";
            return 0;
        }

        if (task_spec.mode == engine::runtime::RunMode::Offline) {
            auto * offline = dynamic_cast<engine::runtime::IOfflineVoiceTaskSession *>(session.get());
            if (offline == nullptr) {
                throw std::runtime_error("selected task session does not support offline execution");
            }
            const auto result = offline->run(request);
            std::cout << "family=" << session->family() << "\n";
            std::cout << "task=" << engine::runtime::to_string(session->task_kind()) << "\n";
            std::cout << "mode=" << engine::runtime::to_string(session->run_mode()) << "\n";
            minitts::app::emit_task_result(
                result,
                optional_path_arg(argc, argv, "--out"),
                optional_path_arg(argc, argv, "--out-dir"),
                optional_path_arg(argc, argv, "--out-dir"),
                optional_path_arg(argc, argv, "--segments-out"),
                optional_path_arg(argc, argv, "--turns-out"),
                optional_path_arg(argc, argv, "--words-out"));
            return 0;
        }

        auto * streaming = dynamic_cast<engine::runtime::IStreamingVoiceTaskSession *>(session.get());
        if (streaming == nullptr) {
            throw std::runtime_error("selected task session does not support streaming execution");
        }
        run_streaming(argc, argv, *streaming, *session, request);
        return 0;
    } catch (const std::exception & ex) {
        std::cerr << "audiocpp_cli failed: " << ex.what() << "\n";
        return 1;
    }
}
