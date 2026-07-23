{
  description = "audio.cpp - High-performance C++ audio inference framework";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      pkgs = forAllSystems (system: import nixpkgs {
        inherit system;
      });
      pkgsCuda = forAllSystems (system: import nixpkgs {
        inherit system;
        config.cudaSupport = true;
        config.allowUnfreePredicate = p:
          builtins.all (
            license:
            license.free
            || builtins.elem license.shortName [
              "CUDA EULA"
              "cuDNN EULA"
              "cuSPARSELt EULA"
            ]
          ) (p.meta.licenses or (nixpkgs.lib.toList (p.meta.license or [])));
      });
    in
    {
      packages = forAllSystems (system:
        let
          # A function to build audio.cpp with any set of features
          mkAudioCpp = { pkgs, cudaSupport ? false, vulkanSupport ? false, metalSupport ? pkgs.stdenv.isDarwin }:
            let
              # Python environment for model_manager.py
              myPython = pkgs.python3.withPackages (ps: with ps; [
                (if cudaSupport then ps.torchWithCuda else if vulkanSupport then ps.torchWithVulkan else ps.torch)
                ps.safetensors
                ps.pyyaml
              ]);
            in
            pkgs.stdenv.mkDerivation {
              pname = "audio.cpp";
              version = self.shortRev or self.dirtyShortRev or "dirty";

              src = ./.;

              nativeBuildInputs = with pkgs; [
                cmake
                ninja
                pkg-config
              ] ++ pkgs.lib.optional cudaSupport pkgs.cudaPackages.cuda_nvcc;

              buildInputs = with pkgs; [
                myPython
              ] ++ pkgs.lib.optionals vulkanSupport [
                vulkan-headers
                vulkan-loader
                vulkan-tools
                glslang
                shaderc
              ] ++ pkgs.lib.optionals cudaSupport [
                pkgs.cudaPackages.cudatoolkit
              ] ++ pkgs.lib.optionals metalSupport [
                pkgs.apple-sdk_14
              ];

              cmakeFlags = [
                "-DCMAKE_BUILD_TYPE=RelWithDebInfo"
                "-DENGINE_ENABLE_NATIVE_CPU=ON"
                "-DENGINE_ENABLE_LLAMAFILE=ON"
              ] ++ pkgs.lib.optional vulkanSupport "-DENGINE_ENABLE_VULKAN=ON"
                ++ pkgs.lib.optional cudaSupport "-DENGINE_ENABLE_CUDA=ON"
                ++ pkgs.lib.optional metalSupport "-DENGINE_ENABLE_METAL=ON";

              installPhase = ''
                runHook preInstall

                mkdir -p $out/bin

                # Copy the built C++ executables directly from the bin directory
                cp bin/audiocpp_cli bin/audiocpp_server bin/audiocpp_gguf $out/bin/

                # Install the python model manager script
                cp $src/tools/model_manager.py $out/bin/audiocpp_model_manager
                chmod +x $out/bin/audiocpp_model_manager

                # Patch the shebang to use our python environment with torch/safetensors/pyyaml
                patchShebangs $out/bin/audiocpp_model_manager

                runHook postInstall
              '';

              meta = with pkgs.lib; {
                description = "A high-performance C++ audio inference framework";
                homepage = "https://github.com/0xShug0/audio.cpp";
                license = licenses.mit;
                platforms = platforms.unix;
                mainProgram = "audiocpp_cli";
              };
            };
        in
        {
          # Expose specific backend variants
          cpu = mkAudioCpp { pkgs = pkgs.${system}; cudaSupport = false; vulkanSupport = false; metalSupport = false; };
          vulkan = mkAudioCpp { pkgs = pkgs.${system}; vulkanSupport = true; cudaSupport = false; metalSupport = false; };
        } // pkgs.${system}.lib.optionalAttrs pkgs.${system}.stdenv.isLinux {
          cuda = mkAudioCpp { pkgs = pkgsCuda.${system}; cudaSupport = true; vulkanSupport = false; metalSupport = false; };
        } // pkgs.${system}.lib.optionalAttrs pkgs.${system}.stdenv.isDarwin {
          metal = mkAudioCpp { pkgs = pkgs.${system}; metalSupport = true; cudaSupport = false; vulkanSupport = false; };
        } // {
          # Automatically select best default for the current platform
          default = if pkgs.${system}.stdenv.isDarwin then self.packages.${system}.metal else self.packages.${system}.vulkan;
        }
      );

      devShells = forAllSystems (system:
        {
          default = pkgs.${system}.mkShell {
            inputsFrom = [ self.packages.${system}.default ];
          };
        } // pkgs.${system}.lib.optionalAttrs pkgs.${system}.stdenv.isLinux {
          cuda = pkgsCuda.${system}.mkShell {
            inputsFrom = [ self.packages.${system}.cuda ];
          };
        }
      );
    };
}
