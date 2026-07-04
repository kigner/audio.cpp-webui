#pragma once

#include "engine/framework/runtime/model.h"
#include "engine/framework/runtime/session_base.h"
#include "engine/models/roformer/assets.h"
#include "engine/models/roformer/runtime.h"

#include <memory>

namespace engine::models::roformer {

class RoformerSession final
    : public runtime::RuntimeSessionBase
    , public runtime::IOfflineVoiceTaskSession {
public:
    RoformerSession(
        const runtime::TaskSpec & task,
        const runtime::SessionOptions & options,
        std::shared_ptr<const RoformerAssets> assets);
    ~RoformerSession() override;

    std::string family() const override;
    runtime::VoiceTaskKind task_kind() const override;
    runtime::RunMode run_mode() const override;
    void prepare(const runtime::SessionPreparationRequest & request) override;
    runtime::TaskResult run(const runtime::TaskRequest & request) override;

private:
    runtime::TaskSpec task_;
    std::shared_ptr<const RoformerAssets> assets_;
    assets::TensorStorageType weight_storage_type_ = assets::TensorStorageType::Native;
    std::unique_ptr<RoformerRuntime> runtime_;
    int64_t chunk_size_ = 0;
    int64_t step_ = 0;
    int64_t fade_size_ = 0;
    int64_t border_ = 0;
    std::vector<float> chunk_window_;
    std::vector<float> chunk_planar_work_;
    std::vector<float> result_work_;
    std::vector<float> counter_work_;
    std::vector<float> vocals_planar_work_;
};

class RoformerLoadedModel final : public runtime::ILoadedVoiceModel {
public:
    explicit RoformerLoadedModel(std::shared_ptr<const RoformerAssets> assets);

    const runtime::ModelMetadata & metadata() const noexcept override;
    const runtime::CapabilitySet & capabilities() const noexcept override;
    std::unique_ptr<runtime::IVoiceTaskSession> create_task_session(
        const runtime::TaskSpec & task,
        const runtime::SessionOptions & options) const override;

private:
    std::shared_ptr<const RoformerAssets> assets_;
};

std::unique_ptr<runtime::ILoadedVoiceModel> load_roformer_model(
    const runtime::ModelLoadRequest & request,
    RoformerFamily family);
std::shared_ptr<runtime::IVoiceModelLoader> make_mel_loader();

}  // namespace engine::models::roformer
