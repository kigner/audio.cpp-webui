#include "engine/models/ace_step/prompt_builder.h"

#include "engine/framework/io/text.h"

#include <algorithm>
#include <cctype>
#include <regex>
#include <sstream>
#include <stdexcept>

namespace engine::models::ace_step {
namespace {

std::string postprocess_caption(std::string value) {
    if (value.empty()) {
        return value;
    }
    std::istringstream lines(value);
    std::string line;
    std::string joined;
    bool first = true;
    while (std::getline(lines, line)) {
        line = engine::io::trim_ascii_whitespace(std::move(line));
        if (line.empty()) {
            continue;
        }
        if (!first) {
            joined.push_back(' ');
        }
        joined += line;
        first = false;
    }
    return joined;
}

std::string metadata_value_or_na(const std::optional<std::string> & value) {
    return value.has_value() && !value->empty() ? *value : "N/A";
}

std::string duration_text(const AceStepMetadata & metadata, float fallback_duration_seconds) {
    if (metadata.duration.has_value() && *metadata.duration > 0) {
        return std::to_string(*metadata.duration) + " seconds";
    }
    const int seconds = fallback_duration_seconds > 0.0F ? std::max(1, static_cast<int>(fallback_duration_seconds)) : 30;
    return std::to_string(seconds) + " seconds";
}

}  // namespace

bool ace_step_metadata_text_is_provided(std::string_view value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string_view::npos) {
        return false;
    }
    const auto last = value.find_last_not_of(" \t\r\n");
    std::string normalized(value.substr(first, last - first + 1));
    std::transform(
        normalized.begin(),
        normalized.end(),
        normalized.begin(),
        [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    return normalized != "n/a";
}

std::string ace_step_metadata_string(const AceStepMetadata & metadata, float duration_seconds) {
    std::ostringstream out;
    out << "- bpm: ";
    if (metadata.bpm.has_value()) {
        out << *metadata.bpm;
    } else {
        out << "N/A";
    }
    out << "\n- timesignature: " << metadata_value_or_na(metadata.timesignature)
        << "\n- keyscale: " << metadata_value_or_na(metadata.keyscale)
        << "\n- duration: " << duration_text(metadata, duration_seconds) << "\n";
    return out.str();
}

std::string ace_step_format_instruction(const std::string & instruction) {
    if (instruction.empty()) {
        return std::string(kDefaultDitInstruction);
    }
    if (instruction.back() == ':') {
        return instruction;
    }
    return instruction + ":";
}

std::string ace_step_format_lyrics(const std::string & lyrics, const std::string & language) {
    return "# Languages\n" + language + "\n\n# Lyric\n" + lyrics + "<|endoftext|>";
}

std::string ace_step_build_dit_caption_prompt(
    const std::string & instruction,
    const std::string & caption,
    const AceStepMetadata & metadata,
    float duration_seconds) {
    std::ostringstream out;
    out << "# Instruction\n"
        << ace_step_format_instruction(instruction)
        << "\n\n# Caption\n"
        << caption
        << "\n\n# Metas\n"
        << ace_step_metadata_string(metadata, duration_seconds)
        << "<|endoftext|>\n";
    return out.str();
}

std::string ace_step_build_lm_prompt(const std::string & caption, const std::string & lyrics) {
    return "# Caption\n" + caption + "\n\n# Lyric\n" + lyrics + "\n";
}

AceStepPlan ace_step_parse_lm_output(const std::string & output_text) {
    AceStepPlan plan;

    const std::regex code_pattern(R"(<\|audio_code_(\d+)\|>)");
    std::string audio_codes_text;
    for (std::sregex_iterator it(output_text.begin(), output_text.end(), code_pattern), end; it != end; ++it) {
        audio_codes_text += it->str();
        plan.audio_code_ids.push_back(std::stoi((*it)[1].str()));
    }
    plan.audio_codes_text = std::move(audio_codes_text);
    plan.frames_5hz = static_cast<int64_t>(plan.audio_code_ids.size());

    std::string reasoning_text;
    const std::regex think_pattern(R"(<think>([\s\S]*?)</think>)");
    std::smatch match;
    if (std::regex_search(output_text, match, think_pattern)) {
        reasoning_text = engine::io::trim_ascii_whitespace(match[1].str());
    } else {
        const size_t code_pos = output_text.find("<|audio_code_");
        reasoning_text = engine::io::trim_ascii_whitespace(
            code_pos == std::string::npos ? output_text : output_text.substr(0, code_pos));
    }

    std::istringstream lines(reasoning_text);
    std::string line;
    std::string current_key;
    std::vector<std::string> current_value_lines;

    const auto flush_field = [&]() {
        if (current_key.empty()) {
            return;
        }
        std::string value;
        for (size_t i = 0; i < current_value_lines.size(); ++i) {
            if (i != 0) {
                value.push_back('\n');
            }
            value += current_value_lines[i];
        }
        value = engine::io::trim_ascii_whitespace(value);
        if (current_key == "caption") {
            plan.cot_caption = value;
            plan.caption = postprocess_caption(value);
        } else if (current_key == "bpm") {
            try {
                plan.metadata.bpm = std::stoll(value);
            } catch (...) {
            }
        } else if (current_key == "duration") {
            try {
                plan.metadata.duration = std::stoll(value);
            } catch (...) {
            }
        } else if (current_key == "keyscale") {
            plan.metadata.keyscale = value;
        } else if (current_key == "timesignature") {
            plan.metadata.timesignature = value;
        } else if (current_key == "language") {
            plan.metadata.language = value;
        } else if (current_key == "genres") {
            plan.metadata.genres = value;
        }
        current_key.clear();
        current_value_lines.clear();
    };

    while (std::getline(lines, line)) {
        if (!line.empty() && line.front() == '<') {
            continue;
        }
        const bool indented = !line.empty() && (line.front() == ' ' || line.front() == '\t');
        if (!indented) {
            const size_t split = line.find(':');
            if (split != std::string::npos) {
                flush_field();
                current_key = engine::io::trim_ascii_whitespace(line.substr(0, split));
                std::transform(current_key.begin(), current_key.end(), current_key.begin(), [](unsigned char ch) {
                    return static_cast<char>(std::tolower(ch));
                });
                const std::string tail = engine::io::trim_ascii_whitespace(line.substr(split + 1));
                if (!tail.empty()) {
                    current_value_lines.push_back(tail);
                }
                continue;
            }
        }
        if (!current_key.empty()) {
            current_value_lines.push_back(line);
        }
    }
    flush_field();

    return plan;
}

}  // namespace engine::models::ace_step
