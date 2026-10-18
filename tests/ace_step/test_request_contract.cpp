#include "engine/models/ace_step/request_parser.h"
#include "engine/models/ace_step/task_route.h"

#include <cmath>
#include <iostream>
#include <stdexcept>

using namespace engine::models::ace_step;

namespace {
void require(bool value, const char * message) {
    if (!value) throw std::runtime_error(message);
}

engine::runtime::TaskRequest request_for(const char * route) {
    engine::runtime::TaskRequest request;
    request.text_input.emplace();
    request.text_input->text = "A warm piano track";
    request.options["route"] = route;
    return request;
}
}

int main() {
    try {
        auto analyze_input = request_for("analyze");
        analyze_input.audio_input.emplace();
        analyze_input.audio_input->sample_rate = 48000;
        analyze_input.audio_input->channels = 1;
        analyze_input.audio_input->samples = {0.1F, -0.1F};
        const auto analyze = ace_step_parse_request(analyze_input);
        require(analyze.task == AceStepTaskType::Analyze, "analyze route lost");
        require(analyze.source_audio.has_value(), "analysis source lost");
        require(ace_step_route_requires_source_audio(ace_step_task_route(analyze)), "analysis must require source audio");

        auto remix_input = request_for("remix");
        remix_input.options["source_caption"] = "Original piano";
        remix_input.options["source_lyrics"] = "Original words";
        remix_input.options["bpm"] = "90";
        remix_input.options["keyscale"] = "C major";
        remix_input.options["timesignature"] = "4";
        remix_input.options["flow_edit_n_min"] = "0.25";
        remix_input.options["flow_edit_n_max"] = "0.75";
        remix_input.options["flow_edit_n_avg"] = "3";
        const auto remix = ace_step_parse_request(remix_input);
        require(remix.task == AceStepTaskType::Remix, "remix route lost");
        require(ace_step_request_uses_flow_edit_morph(remix), "remix must use flow-edit");
        require(remix.source_caption == "Original piano" && remix.source_lyrics == "Original words", "source conditioning lost");
        require(remix.bpm == 90 && remix.keyscale == "C major" && remix.timesignature == "4", "analysis metadata lost");
        require(std::abs(remix.generation.flow_edit_n_min - 0.25F) < 1e-6F &&
                std::abs(remix.generation.flow_edit_n_max - 0.75F) < 1e-6F &&
                remix.generation.flow_edit_n_avg == 3, "flow-edit controls lost");
        require(remix.generation.num_inference_steps == 16 && remix.generation.shift == 3.0F, "remix defaults changed");
        require(ace_step_task_instruction(ace_step_task_route(remix), remix) ==
                ace_step_task_instruction(ace_step_task_route(AceStepTaskType::Cover), remix), "remix must use the trained cover instruction");

        auto rewrite_input = request_for("text2music");
        rewrite_input.options["rewrite_caption"] = "true";
        const auto rewrite = ace_step_parse_request(rewrite_input);
        require(rewrite.rewrite_caption, "upstream caption rewrite lost");
        require(rewrite.generation.num_inference_steps == 8, "ordinary generation defaults changed");
        require(!ace_step_request_uses_flow_edit_morph(rewrite), "ordinary generation became remix");
        std::cout << "ACE-Step request contracts passed\n";
        return 0;
    } catch (const std::exception & error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
