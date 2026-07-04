#include "config.h"

#include "../cli/args.h"
#include "../cli/request.h"

#include "engine/framework/io/json.h"

#include <stdexcept>
#include <utility>

namespace minitts::server {
namespace {

std::filesystem::path resolve_path(const std::filesystem::path & base, const std::filesystem::path & path) {
    return path.is_absolute() ? path : base / path;
}

std::unordered_map<std::string, std::string> options_from_object(const engine::io::json::Value * value) {
    return minitts::cli::json_options_map(value);
}

}  // namespace

engine::core::BackendType parse_server_backend(const std::string & value) {
    auto backend = minitts::cli::parse_backend(value);
    if (backend == engine::core::BackendType::BestAvailable) {
        throw std::runtime_error("unsupported server backend: " + value);
    }
    return backend;
}

ServerConfig load_server_config(const std::filesystem::path & path) {
    const auto root = engine::io::json::parse_file(path);
    const auto base = path.parent_path();
    ServerConfig config;
    config.host = engine::io::json::optional_string(root, "host", config.host);
    config.port = engine::io::json::optional_i32(root, "port", config.port);
    config.backend = parse_server_backend(engine::io::json::optional_string(root, "backend", "cuda"));
    config.device = engine::io::json::optional_i32(root, "device", config.device);
    config.threads = engine::io::json::optional_i32(root, "threads", config.threads);
    config.lazy_load = engine::io::json::optional_bool(root, "lazy_load", config.lazy_load);
    if (config.port <= 0 || config.port > 65535) {
        throw std::runtime_error("server port must be in 1..65535");
    }
    if (config.threads <= 0) {
        throw std::runtime_error("server threads must be positive");
    }

    const auto * models = root.find("models");
    if (models == nullptr || !models->is_array() || models->as_array().empty()) {
        throw std::runtime_error("server config requires a non-empty models array");
    }
    for (const auto & item : models->as_array()) {
        ServerModelConfig model;
        model.id = engine::io::json::require_string(item, "id");
        model.path = resolve_path(base, engine::io::json::require_string(item, "path"));
        model.family = engine::io::json::require_string(item, "family");
        model.task = engine::io::json::optional_string(item, "task", model.task);
        model.mode = engine::io::json::optional_string(item, "mode", model.mode);
        model.lazy = engine::io::json::optional_bool(item, "lazy", config.lazy_load);
        if (const auto * value = item.find("config")) {
            model.config_id = value->as_string();
        }
        if (const auto * value = item.find("weight")) {
            model.weight_id = value->as_string();
        }
        model.load_options = options_from_object(item.find("load_options"));
        model.session_options = options_from_object(item.find("session_options"));
        config.models.push_back(std::move(model));
    }
    return config;
}

}  // namespace minitts::server
