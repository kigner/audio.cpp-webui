#pragma once

#include "engine/framework/assets/resource_bundle.h"

#include <filesystem>
#include <string_view>

namespace engine::assets {

enum class ModelPackageResourceKind {
    Files,
    Tensors,
};

[[nodiscard]] std::filesystem::path default_model_package_spec_path(std::string_view family);

[[nodiscard]] ResourceBundle load_resource_bundle_from_package_spec(
    const std::filesystem::path & model_path,
    const std::filesystem::path & spec_path);

[[nodiscard]] std::vector<ResourceFile> discover_resources_from_package_spec(
    const std::filesystem::path & model_path,
    const std::filesystem::path & spec_path,
    ModelPackageResourceKind kind);

}  // namespace engine::assets
