#include "config.h"

#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {

void require(bool condition, const std::string & message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

std::filesystem::path make_temp_root() {
    const auto root = std::filesystem::temp_directory_path() / "audiocpp_server_config_test";
    std::error_code ec;
    std::filesystem::remove_all(root, ec);
    std::filesystem::create_directories(root);
    return root;
}

std::filesystem::path write_config(
    const std::filesystem::path & root,
    const std::string & name,
    const std::string & text) {
    const auto path = root / name;
    std::ofstream out(path);
    if (!out) {
        throw std::runtime_error("failed to create test config: " + path.string());
    }
    out << text;
    if (!out) {
        throw std::runtime_error("failed to write test config: " + path.string());
    }
    return path;
}

void test_inline_default_and_named_presets() {
    const auto root = make_temp_root();
    const auto config_path = write_config(
        root,
        "server.json",
        R"JSON({
  "host": "127.0.0.1",
  "port": 8080,
  "backend": "cpu",
  "models": [
    {
      "id": "tts",
      "family": "omnivoice",
      "path": "models/OmniVoice",
      "task": "tts",
      "default_voice_preset": {
        "voice_ref": "voices/default.wav",
        "reference_text": "default transcript"
      },
      "voice_presets": {
        "assistant": {
          "voice_ref": "voices/assistant.wav",
          "reference_text": "assistant transcript"
        },
        "builtin": {
          "voice_id": "alba"
        }
      }
    }
  ]
})JSON");

    const auto config = minitts::server::load_server_config(config_path);
    require(config.models.size() == 1, "one model parsed");
    const auto & model = config.models.front();
    require(model.path == root / "models/OmniVoice", "model path is resolved relative to config");
    require(model.default_voice_preset.has_value(), "inline default preset parsed");
    require(model.default_voice_preset->voice_ref == root / "voices/default.wav", "default voice_ref path resolved");
    require(model.default_voice_preset->reference_text == "default transcript", "default reference_text parsed");
    require(model.voice_presets.size() == 2, "named presets parsed");
    require(model.voice_presets.at("assistant").voice_ref == root / "voices/assistant.wav", "named voice_ref path resolved");
    require(model.voice_presets.at("assistant").reference_text == "assistant transcript", "named reference_text parsed");
    require(model.voice_presets.at("builtin").voice_id == "alba", "named voice_id parsed");
}

void test_default_preset_name() {
    const auto root = make_temp_root();
    const auto config_path = write_config(
        root,
        "server_named_default.json",
        R"JSON({
  "models": [
    {
      "id": "tts",
      "family": "pocket_tts",
      "path": "models/pocket-tts",
      "voice_presets": {
        "narrator": {
          "voice_id": "cosette"
        }
      },
      "default_voice_preset": "narrator"
    }
  ]
})JSON");

    const auto config = minitts::server::load_server_config(config_path);
    const auto & model = config.models.front();
    require(model.default_voice_preset_id == "narrator", "default preset name parsed");
    require(!model.default_voice_preset.has_value(), "named default does not create inline preset");
}

void test_missing_default_preset_name_is_rejected() {
    const auto root = make_temp_root();
    const auto config_path = write_config(
        root,
        "server_bad_default.json",
        R"JSON({
  "models": [
    {
      "id": "tts",
      "family": "pocket_tts",
      "path": "models/pocket-tts",
      "voice_presets": {
        "narrator": {
          "voice_id": "cosette"
        }
      },
      "default_voice_preset": "missing"
    }
  ]
})JSON");

    bool rejected = false;
    try {
        (void) minitts::server::load_server_config(config_path);
    } catch (const std::runtime_error & error) {
        rejected = std::string(error.what()).find("does not match") != std::string::npos;
    }
    require(rejected, "unknown default preset name is rejected");
}

}  // namespace

int main() {
    try {
        test_inline_default_and_named_presets();
        test_default_preset_name();
        test_missing_default_preset_name_is_rejected();
    } catch (const std::exception & error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
    std::cout << "server_config_test passed\n";
    return 0;
}
