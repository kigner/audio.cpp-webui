#include "engine/models/ace_step/task_route.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <stdexcept>
#include <string>

namespace engine::models::ace_step {
namespace {

constexpr std::array<AceStepTaskRoute, 7> kRoutes = {{
    // task, name, planner, source policy, source duration lock,
    // repaint window, preserve repaint source, cover conditioning, DiT
    // instruction, missing component.
    {
        AceStepTaskType::TextToMusic,
        "text2music",
        true,
        AceStepSourceAudioPolicy::Ignored,
        false,
        false,
        false,
        false,
        "Fill the audio semantic mask based on the given conditions:",
        "",
    },
    {
        AceStepTaskType::Cover,
        "cover",
        false,
        AceStepSourceAudioPolicy::Required,
        true,
        false,
        false,
        true,
        "Generate audio semantic tokens based on the given conditions:",
        "",
    },
    {
        AceStepTaskType::CoverNoFsq,
        "cover-nofsq",
        false,
        AceStepSourceAudioPolicy::Required,
        true,
        false,
        false,
        false,
        "Generate audio semantic tokens based on the given conditions:",
        "",
    },
    {
        AceStepTaskType::Repaint,
        "repaint",
        false,
        AceStepSourceAudioPolicy::Required,
        true,
        true,
        false,
        false,
        "Repaint the mask area based on the given conditions:",
        "",
    },
    {
        AceStepTaskType::Extract,
        "extract",
        false,
        AceStepSourceAudioPolicy::Required,
        true,
        false,
        false,
        false,
        "Extract the track from the audio:",
        "",
    },
    {
        AceStepTaskType::Lego,
        "lego",
        true,
        AceStepSourceAudioPolicy::Required,
        true,
        true,
        true,
        false,
        "Generate the track based on the audio context:",
        "",
    },
    {
        AceStepTaskType::Complete,
        "complete",
        true,
        AceStepSourceAudioPolicy::Optional,
        false,
        false,
        false,
        false,
        "Complete the input track:",
        "",
    },
}};

std::string upper_ascii(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char ch) { return static_cast<char>(std::toupper(ch)); });
    return value;
}

}  // namespace

AceStepTaskType ace_step_parse_task_type(std::string_view task_type) {
    for (const AceStepTaskRoute & route : kRoutes) {
        if (task_type == route.name) {
            return route.task;
        }
    }
    throw std::runtime_error("Unsupported ACE-Step route: " + std::string(task_type));
}

std::string_view ace_step_task_type_name(AceStepTaskType task) {
    return ace_step_task_route(task).name;
}

const AceStepTaskRoute & ace_step_task_route(AceStepTaskType task) {
    for (const AceStepTaskRoute & route : kRoutes) {
        if (route.task == task) {
            return route;
        }
    }
    throw std::runtime_error("Unsupported ACE-Step task enum");
}

const AceStepTaskRoute & ace_step_task_route(const AceStepRequest & request) {
    return ace_step_task_route(request.task);
}

std::string ace_step_task_instruction(const AceStepTaskRoute & route, const AceStepRequest & request) {
    const std::string_view default_text2music_instruction =
        ace_step_task_route(AceStepTaskType::TextToMusic).dit_instruction;
    if (!request.instruction.empty() && request.instruction != default_text2music_instruction) {
        return request.instruction;
    }
    if (route.task == AceStepTaskType::Complete && !request.complete_track_classes.empty()) {
        std::string out = "Complete the input track with ";
        for (size_t i = 0; i < request.complete_track_classes.size(); ++i) {
            if (i > 0) {
                out += " | ";
            }
            out += upper_ascii(request.complete_track_classes[i]);
        }
        out += ":";
        return out;
    }
    if (route.task == AceStepTaskType::Lego && !request.track_name.empty()) {
        return "Generate the " + upper_ascii(request.track_name) + " track based on the audio context:";
    }
    if (route.task != AceStepTaskType::Extract || request.track_name.empty()) {
        return std::string(route.dit_instruction);
    }
    return "Extract the " + upper_ascii(request.track_name) + " track from the audio:";
}

bool ace_step_route_uses_repaint_window(const AceStepTaskRoute & route) {
    return route.uses_repaint_window;
}

bool ace_step_route_accepts_source_audio(const AceStepTaskRoute & route) {
    return route.source_audio_policy != AceStepSourceAudioPolicy::Ignored;
}

bool ace_step_route_requires_source_audio(const AceStepTaskRoute & route) {
    return route.source_audio_policy == AceStepSourceAudioPolicy::Required;
}

bool ace_step_route_uses_request_source_audio(
    const AceStepTaskRoute & route,
    const AceStepRequest & request,
    const AceStepPlan & plan) {
    return request.source_audio.has_value() &&
           (ace_step_route_accepts_source_audio(route) || ace_step_request_uses_flow_edit_morph(request)) &&
           plan.audio_code_ids.empty();
}

bool ace_step_route_has_required_source_audio_input(
    const AceStepTaskRoute & route,
    const AceStepRequest & request,
    const AceStepPlan & plan) {
    if (ace_step_request_uses_flow_edit_morph(request)) {
        return request.source_audio.has_value();
    }
    return !ace_step_route_requires_source_audio(route) ||
           request.source_audio.has_value() ||
           !plan.audio_code_ids.empty();
}

bool ace_step_route_has_missing_component(const AceStepTaskRoute & route) {
    return !route.missing_component.empty();
}

bool ace_step_request_uses_flow_edit_morph(const AceStepRequest & request) {
    return request.task == AceStepTaskType::TextToMusic && request.generation.flow_edit_morph;
}

}  // namespace engine::models::ace_step
