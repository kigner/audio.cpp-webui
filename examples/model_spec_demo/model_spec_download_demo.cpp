#include "engine/framework/model_spec/package.h"

#include <exception>
#include <iostream>
#include <string>

namespace {

namespace json = engine::io::json;

std::string optional_string(const json::Value & object, const std::string & key) {
    const auto * value = object.find(key);
    return value != nullptr && value->is_string() ? value->as_string() : std::string();
}

void print_string_array(const json::Value * value, const char * label) {
    if (value == nullptr) {
        return;
    }
    std::cout << "  " << label << "=";
    bool first = true;
    for (const auto & item : value->as_array()) {
        if (!first) {
            std::cout << ",";
        }
        std::cout << item.as_string();
        first = false;
    }
    std::cout << "\n";
}

void print_download_plan(const json::Value & package) {
    const auto & download = package.require("download");
    const auto kind = download.require("kind").as_string();
    std::cout << "package=" << package.require("id").as_string() << "\n";
    std::cout << "  target=" << package.require("target_directory").as_string() << "\n";
    std::cout << "  format=" << package.require("format").as_string() << "\n";
    std::cout << "  precision=" << package.require("precision").as_string() << "\n";
    std::cout << "  download_kind=" << kind << "\n";
    if (kind == "huggingface_snapshot") {
        std::cout << "  repo=" << download.require("repo").as_string() << "\n";
        const auto revision = optional_string(download, "revision");
        if (!revision.empty()) {
            std::cout << "  revision=" << revision << "\n";
        }
        const auto strip_prefix = optional_string(download, "strip_prefix");
        if (!strip_prefix.empty()) {
            std::cout << "  strip_prefix=" << strip_prefix << "\n";
        }
        print_string_array(download.find("include"), "include");
        print_string_array(download.find("exclude"), "exclude");
    } else if (kind == "local_snapshot") {
        std::cout << "  path=" << download.require("path").as_string() << "\n";
        print_string_array(download.find("include"), "include");
    } else if (kind == "converter") {
        std::cout << "  converter=" << download.require("converter").as_string() << "\n";
        std::cout << "  description=" << download.require("description").as_string() << "\n";
    } else if (kind == "unsupported") {
        std::cout << "  reason=" << download.require("reason").as_string() << "\n";
    }
}

}  // namespace

int main(int argc, char ** argv) {
    if (argc != 2 && argc != 3) {
        std::cerr << "usage: model_spec_download_demo <spec.json> [package-id]\n";
        return 2;
    }
    try {
        const auto spec = engine::model_spec::load_spec(argv[1]);
        const std::string selected = argc == 3 ? argv[2] : std::string();
        bool found = false;
        std::cout << "family=" << spec.require("family").as_string() << "\n";
        for (const auto & package : spec.require("packages").as_array()) {
            if (!selected.empty() && package.require("id").as_string() != selected) {
                continue;
            }
            print_download_plan(package);
            found = true;
        }
        if (!selected.empty() && !found) {
            std::cerr << "package not found: " << selected << "\n";
            return 1;
        }
        return 0;
    } catch (const std::exception & error) {
        std::cerr << "model_spec_download_demo failed: " << error.what() << "\n";
        return 1;
    }
}
