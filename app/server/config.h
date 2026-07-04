#pragma once

#include <filesystem>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "engine/framework/core/backend.h"

namespace minitts::server {

struct ServerModelConfig {
    std::string id;
    std::filesystem::path path;
    std::string family;
    std::string task = "tts";
    std::string mode = "offline";
    bool lazy = false;
    std::optional<std::string> config_id;
    std::optional<std::string> weight_id;
    std::unordered_map<std::string, std::string> load_options;
    std::unordered_map<std::string, std::string> session_options;
};

struct ServerConfig {
    std::string host = "127.0.0.1";
    int port = 8080;
    engine::core::BackendType backend = engine::core::BackendType::Cuda;
    int device = 0;
    int threads = 1;
    bool lazy_load = false;
    std::vector<ServerModelConfig> models;
};

engine::core::BackendType parse_server_backend(const std::string & value);
ServerConfig load_server_config(const std::filesystem::path & path);

}  // namespace minitts::server
