#include "../../src/models/rvc/retrieval_index.h"
#include "engine/framework/assets/tensor_source.h"
#include "engine/framework/io/safetensors.h"
#include "test_assert.h"

#include <chrono>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

namespace {

engine::io::SafeTensorWriteEntry tensor(
    const std::string & name, std::vector<int64_t> shape, const std::vector<float> & values) {
    engine::io::SafeTensorWriteEntry out{name, "F32", std::move(shape), {}};
    out.data.resize(values.size() * sizeof(float));
    std::memcpy(out.data.data(), values.data(), out.data.size());
    return out;
}

void write_index(const std::filesystem::path & path, const std::vector<float> & offsets,
                 const std::vector<float> & lengths, int64_t count) {
    const auto lists = static_cast<int64_t>(lengths.size());
    engine::io::write_safetensors_file(path, {
        tensor("centroids", {lists, 2}, std::vector<float>(static_cast<size_t>(lists * 2), 0.0F)),
        tensor("vectors", {count, 2}, std::vector<float>(static_cast<size_t>(count * 2), 1.0F)),
        tensor("list_offsets", {lists}, offsets),
        tensor("list_lengths", {lists}, lengths),
    });
}

template <typename Function>
void rejects(Function function, const std::string & label) {
    bool rejected = false;
    try { function(); } catch (const std::runtime_error &) { rejected = true; }
    engine::test::require(rejected, label);
}

void run(const std::filesystem::path & root) {
    const auto source = root / "index.safetensors";
    const auto gguf = root / "index-f16.gguf";
    std::vector<float> lengths(64, 64.0F);
    lengths.insert(lengths.end(), {3.0F, 1.0F});
    std::vector<float> offsets;
    int64_t total = 0;
    for (const float length : lengths) {
        offsets.push_back(static_cast<float>(total));
        total += static_cast<int64_t>(length);
    }
    write_index(source, offsets, lengths, total);
    auto index = engine::models::rvc::load_rvc_retrieval_index(source, 2);
    engine::test::require_eq(index.list_offsets.back(), int64_t{4099}, "F32 offsets preserved");

    engine::assets::convert_tensor_sources_to_gguf(
        {{source, ""}}, gguf, engine::assets::TensorStorageType::F16, true, false);
    const auto packed = engine::assets::open_tensor_source(gguf);
    engine::test::require(packed->require_f32("list_offsets").back() == 4100.0F,
                          "fixture reproduces F16 offset rounding beyond final vector");
    index = engine::models::rvc::load_rvc_retrieval_index(packed, 2, "legacy F16 fixture");
    engine::test::require_eq(index.list_offsets.back(), int64_t{4099}, "recover exact contiguous offset");
    engine::test::require_eq(index.list_offsets.back() + index.list_lengths.back(), total,
                            "last recovered range ends exactly at vector count");

    offsets.back() = 4000.0F;
    write_index(source, offsets, lengths, total);
    engine::assets::convert_tensor_sources_to_gguf(
        {{source, ""}}, gguf, engine::assets::TensorStorageType::F16, true, false);
    rejects([&] { engine::models::rvc::load_rvc_retrieval_index(gguf, 2); },
            "arbitrary F16 offsets must not be silently reconstructed");

    for (const float invalid : {4100.0F, -1.0F, 1.5F,
                               std::numeric_limits<float>::infinity(),
                               std::numeric_limits<float>::quiet_NaN(),
                               static_cast<float>(std::numeric_limits<int64_t>::max())}) {
        offsets.back() = invalid;
        write_index(source, offsets, lengths, total);
        rejects([&] { engine::models::rvc::load_rvc_retrieval_index(source, 2); },
                "invalid F32 offset must be rejected before retrieval");
    }
    offsets.back() = 4099.0F;
    lengths.back() = 2.0F;
    write_index(source, offsets, lengths, total);
    rejects([&] { engine::models::rvc::load_rvc_retrieval_index(source, 2); },
            "oversized list must be rejected before retrieval");
}

}  // namespace

int main() {
    const auto root = std::filesystem::temp_directory_path() /
        ("audiocpp_rvc_index_test_" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directory(root);
    int result = 0;
    try { run(root); std::cout << "RVC retrieval index tests passed\n"; }
    catch (const std::exception & error) { std::cerr << error.what() << '\n'; result = 1; }
    for (const char * name : {"index.safetensors", "index-f16.gguf"}) {
        std::error_code ec;
        std::filesystem::remove(root / name, ec);
    }
    std::error_code ec;
    std::filesystem::remove(root, ec);
    return result;
}
