#include "engine/framework/core/backend.h"
#include "engine/framework/modules/conv_modules.h"

#include <ggml-backend.h>
#include <ggml.h>

#include <cmath>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr size_t kTestGraphBytes = 256 * 1024 * 1024;
constexpr size_t kTestGraphNodes = 4096;

struct ConvTransposeCase {
    const char * name;
    int64_t batch;
    int64_t in_channels;
    int64_t out_channels;
    int64_t frames;
    int64_t kernel_size;
    int stride;
    bool use_bias;
};

struct RunResult {
    engine::core::TensorShape shape;
    std::vector<float> values;
};

std::vector<float> make_patterned_f32(size_t count, float phase, float scale) {
    std::vector<float> values(count, 0.0f);
    for (size_t i = 0; i < count; ++i) {
        const float x = static_cast<float>(i);
        values[i] = scale * (std::sin(phase + 0.113f * x) + 0.5f * std::cos(phase * 0.7f + 0.071f * x));
    }
    return values;
}

struct BackendModuleRunner {
    engine::core::BackendConfig backend_config{engine::core::BackendType::Cpu, 0, 4};
    ggml_backend_t backend = nullptr;
    ggml_backend_buffer_t buffer = nullptr;
    ggml_context * ggml = nullptr;
    engine::core::ModuleBuildContext ctx{};

    BackendModuleRunner(const char * name, engine::core::BackendType backend_type) {
        backend_config.type = backend_type;
        backend = engine::core::init_backend(backend_config);
        ggml_init_params params{};
        params.mem_size = kTestGraphBytes;
        params.mem_buffer = nullptr;
        params.no_alloc = true;
        ggml = ggml_init(params);
        if (ggml == nullptr) {
            throw std::runtime_error("failed to init test ggml context");
        }
        ctx.ggml = ggml;
        ctx.module_instance_name = name;
        ctx.backend_type = backend_type;
    }

    ~BackendModuleRunner() {
        if (buffer != nullptr) {
            ggml_backend_buffer_free(buffer);
        }
        if (ggml != nullptr) {
            ggml_free(ggml);
        }
        if (backend != nullptr) {
            ggml_backend_free(backend);
        }
    }

    engine::core::TensorValue make_f32(const engine::core::TensorShape & shape) {
        return engine::core::make_tensor(ctx, GGML_TYPE_F32, shape);
    }

    void allocate_tensors() {
        if (buffer != nullptr) {
            return;
        }
        buffer = ggml_backend_alloc_ctx_tensors(ggml, backend);
        if (buffer == nullptr) {
            throw std::runtime_error("failed to allocate test backend tensors");
        }
    }

    RunResult run_f32(const engine::core::TensorValue & output) {
        allocate_tensors();
        ggml_cgraph * graph = ggml_new_graph_custom(ggml, kTestGraphNodes, false);
        ggml_build_forward_expand(graph, output.tensor);
        const ggml_status status = ggml_backend_graph_compute(backend, graph);
        if (status != GGML_STATUS_SUCCESS) {
            std::ostringstream oss;
            oss << "backend graph compute failed with status " << static_cast<int>(status);
            throw std::runtime_error(oss.str());
        }
        RunResult result{output.shape, {}};
        engine::core::read_tensor_f32_into(output.tensor, result.values);
        return result;
    }
};

bool backend_is_available(engine::core::BackendType backend_type) {
    try {
        BackendModuleRunner runner("conv_transpose_fast_path_test.probe", backend_type);
        return true;
    } catch (...) {
        return false;
    }
}

void write_tensor_f32(const engine::core::TensorValue & tensor, const std::vector<float> & values, const char * name) {
    if (static_cast<int64_t>(values.size()) != tensor.shape.num_elements()) {
        std::ostringstream oss;
        oss << name << " value count mismatch: expected " << tensor.shape.num_elements()
            << ", got " << values.size();
        throw std::runtime_error(oss.str());
    }
    ggml_backend_tensor_set(tensor.tensor, values.data(), 0, values.size() * sizeof(float));
}

engine::modules::ConvTranspose1dConfig make_config(const ConvTransposeCase & test_case) {
    return {
        test_case.in_channels,
        test_case.out_channels,
        test_case.kernel_size,
        test_case.stride,
        0,
        1,
        test_case.use_bias,
    };
}

RunResult run_conv_transpose_case(
    const ConvTransposeCase & test_case,
    engine::core::BackendType backend_type) {
    BackendModuleRunner runner(
        backend_type == engine::core::BackendType::Cuda ? "conv_transpose_fast_path_test.cuda" : "conv_transpose_fast_path_test.reference",
        backend_type);

    const auto input_shape = engine::core::TensorShape::from_dims(
        {test_case.batch, test_case.in_channels, test_case.frames});
    const auto weight_shape = engine::core::TensorShape::from_dims(
        {test_case.in_channels, test_case.out_channels, test_case.kernel_size});
    const auto bias_shape = engine::core::TensorShape::from_dims({test_case.out_channels});

    auto input = runner.make_f32(input_shape);
    auto weight = runner.make_f32(weight_shape);
    std::optional<engine::core::TensorValue> bias;
    if (test_case.use_bias) {
        bias = runner.make_f32(bias_shape);
    }

    const auto output = engine::modules::ConvTranspose1dModule(make_config(test_case))
        .build(runner.ctx, input, engine::modules::ConvTranspose1dWeights{weight, bias});

    runner.allocate_tensors();
    write_tensor_f32(input, make_patterned_f32(static_cast<size_t>(input_shape.num_elements()), 0.19f, 0.031f), "input");
    write_tensor_f32(weight, make_patterned_f32(static_cast<size_t>(weight_shape.num_elements()), 0.47f, 0.017f), "weight");
    if (bias) {
        write_tensor_f32(*bias, make_patterned_f32(static_cast<size_t>(bias_shape.num_elements()), 0.83f, 0.011f), "bias");
    }

    return runner.run_f32(output);
}

void require_fast_path_trigger_conditions(engine::core::BackendType backend_type) {
    BackendModuleRunner cuda_runner("conv_transpose_fast_path_test.cuda_trigger", backend_type);
    BackendModuleRunner cpu_runner("conv_transpose_fast_path_test.cpu_trigger", engine::core::BackendType::Cpu);

    const ConvTransposeCase test_case{"trigger_condition_probe", 1, 256, 128, 96, 10, 5, true};
    auto eligible_config = make_config(test_case);
    if (!engine::modules::is_conv_transpose1d_col2im_fast_path_eligible(cuda_runner.ctx, eligible_config)) {
        throw std::runtime_error("expected Qwen3-style CUDA conv-transpose config to be col2im fast-path eligible");
    }
    if (engine::modules::is_conv_transpose1d_col2im_fast_path_eligible(cpu_runner.ctx, eligible_config)) {
        throw std::runtime_error("CPU conv-transpose config must not be col2im fast-path eligible");
    }

    auto dilated_config = eligible_config;
    dilated_config.dilation = 2;
    if (engine::modules::is_conv_transpose1d_col2im_fast_path_eligible(cuda_runner.ctx, dilated_config)) {
        throw std::runtime_error("dilated conv-transpose config must not be col2im fast-path eligible");
    }
}

void require_same_shape(const engine::core::TensorShape & lhs, const engine::core::TensorShape & rhs, const char * label) {
    if (lhs.rank != rhs.rank) {
        throw std::runtime_error(std::string(label) + " rank mismatch");
    }
    for (size_t i = 0; i < lhs.rank; ++i) {
        if (lhs.dims[i] != rhs.dims[i]) {
            std::ostringstream oss;
            oss << label << " shape mismatch: " << lhs.to_string() << " vs " << rhs.to_string();
            throw std::runtime_error(oss.str());
        }
    }
}

void require_close(const RunResult & slow, const RunResult & fast, const ConvTransposeCase & test_case) {
    require_same_shape(slow.shape, fast.shape, test_case.name);
    if (slow.values.size() != fast.values.size()) {
        throw std::runtime_error(std::string(test_case.name) + " value count mismatch");
    }

    float max_diff = 0.0f;
    size_t max_index = 0;
    double mean_diff = 0.0;
    for (size_t i = 0; i < slow.values.size(); ++i) {
        const float diff = std::fabs(slow.values[i] - fast.values[i]);
        mean_diff += diff;
        if (diff > max_diff) {
            max_diff = diff;
            max_index = i;
        }
    }
    mean_diff /= static_cast<double>(slow.values.size());

    constexpr float kMaxAllowed = 2.0e-5f;
    constexpr double kMeanAllowed = 2.0e-6;
    if (max_diff > kMaxAllowed || mean_diff > kMeanAllowed) {
        std::ostringstream oss;
        oss << test_case.name << " slow/fast drift exceeds bounds: max diff=" << max_diff
            << " at " << max_index << " (slow=" << slow.values[max_index]
            << ", fast=" << fast.values[max_index] << "), mean diff=" << mean_diff;
        throw std::runtime_error(oss.str());
    }
}

void run_case(const ConvTransposeCase & test_case, engine::core::BackendType backend_type) {
    const RunResult reference = run_conv_transpose_case(test_case, engine::core::BackendType::Cpu);
    const RunResult fast = run_conv_transpose_case(test_case, backend_type);
    require_close(reference, fast, test_case);
    std::cout << "[PASS] " << test_case.name << " output " << reference.shape.to_string() << '\n';
}

}  // namespace

int main() {
    try {
        constexpr auto kBackend = engine::core::BackendType::Cuda;
        if (!backend_is_available(kBackend)) {
            std::cout << "[SKIP] CUDA backend is not available for conv transpose fast-path parity test\n";
            return 0;
        }
        require_fast_path_trigger_conditions(kBackend);
        run_case({"qwen3_decoder_mid_block_biased", 1, 256, 128, 96, 10, 5, true}, kBackend);
        run_case({"batched_decoder_block_no_bias", 2, 192, 192, 48, 2, 2, false}, kBackend);
    } catch (const std::exception & ex) {
        std::cerr << "[FAIL] " << ex.what() << '\n';
        return 1;
    }
    return 0;
}
