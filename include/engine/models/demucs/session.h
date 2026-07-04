#pragma once

#include "engine/framework/runtime/model.h"
#include "engine/framework/runtime/session_base.h"
#include "engine/models/demucs/assets.h"
#include "engine/models/demucs/pipeline.h"

#include <memory>
#include <vector>

namespace engine::models::demucs {

class HTDemucsSession final
    : public runtime::RuntimeSessionBase
    , public runtime::IOfflineVoiceTaskSession {
public:
    HTDemucsSession(
        const runtime::TaskSpec & task,
        const runtime::SessionOptions & options,
        std::shared_ptr<const DemucsAssets> assets);
    ~HTDemucsSession() override;

    std::string family() const override;
    runtime::VoiceTaskKind task_kind() const override;
    runtime::RunMode run_mode() const override;
    void prepare(const runtime::SessionPreparationRequest & request) override;
    runtime::TaskResult run(const runtime::TaskRequest & request) override;

private:
    runtime::TaskSpec task_;
    std::shared_ptr<const DemucsAssets> assets_;
    assets::TensorStorageType weight_storage_type_ = assets::TensorStorageType::Native;
    std::unique_ptr<HTDemucsPipeline> pipeline_;
    int64_t chunk_size_ = 0;
    int64_t step_ = 0;
    std::vector<float> chunk_window_;
    std::vector<float> chunk_planar_work_;
    std::vector<float> result_work_;
    std::vector<float> counter_work_;
};

class HTDemucsLoadedModel final : public runtime::ILoadedVoiceModel {
public:
    explicit HTDemucsLoadedModel(std::shared_ptr<const DemucsAssets> assets);

    const runtime::ModelMetadata & metadata() const noexcept override;
    const runtime::CapabilitySet & capabilities() const noexcept override;
    std::unique_ptr<runtime::IVoiceTaskSession> create_task_session(
        const runtime::TaskSpec & task,
        const runtime::SessionOptions & options) const override;

private:
    std::shared_ptr<const DemucsAssets> assets_;
};

std::unique_ptr<runtime::ILoadedVoiceModel> load_htdemucs_model(
    const runtime::ModelLoadRequest & request);
std::shared_ptr<runtime::IVoiceModelLoader> make_htdemucs_loader();

}  // namespace engine::models::demucs
