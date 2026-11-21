# Keep the Core ML build and its encoder next to the local model files, not in
# Homebrew's whisper.cpp (which is built without Core ML support).
WHISPER_COREML_DIR := ./.cache/whisper.cpp-coreml
WHISPER_COREML_SERVER := $(WHISPER_COREML_DIR)/build/bin/whisper-server

# Pinned Inkling-compatible Metal build.
LLAMA_SERVER ?= ./.cache/llama.cpp-inkling/llama-b12588-mix-c0c3de8/llama-server

# Resolve through the deployed makefile symlink; no runtime files live in /tmp.
MLX_DIR := $(abspath $(dir $(realpath $(lastword $(MAKEFILE_LIST))))../mlx)
MLX_PYTHON := $(HOME)/local-models/.cache/inkling-mlx-env/bin/python

.PHONY: llamacpp mlx mlx-setup whisper whisper-setup whisper-tiny

llamacpp: mlx-setup
	@node "$(MLX_DIR)/gateway.mjs" --python "$(MLX_PYTHON)" -- $(LLAMA_SERVER) \
		--host 127.0.0.1 \
		--models-preset ./preset.ini \
		--models-dir ./ \
		--models-memory-margin 4096 \
		--port 8080 \
		--cache-prompt \
		--ubatch-size 2048 \
		--batch-size 2048 \
		--flash-attn on \
		--cache-type-k q8_0 \
		--cache-type-v q8_0 \
		--webui-mcp-proxy \
		--gpu-layers 99 \
		--reasoning-preserve

# Standalone lightweight endpoint; the GPU worker starts only for inference.
mlx: mlx-setup
	@node "$(MLX_DIR)/gateway.mjs" --python "$(MLX_PYTHON)"

mlx-setup:
	@node "$(MLX_DIR)/setup.mjs"

whisper-setup:
	@if [ ! -d "$(WHISPER_COREML_DIR)/.git" ]; then \
		git clone --depth 1 --branch v1.9.2 https://github.com/ggml-org/whisper.cpp.git "$(WHISPER_COREML_DIR)"; \
	fi
	@hf download ggerganov/whisper.cpp ggml-tiny.bin ggml-tiny-encoder.mlmodelc.zip \
		--revision 5359861c739e955e79d9a303bcbc70fb988958b1 --local-dir . --format quiet >/dev/null
	@unzip -qo ggml-tiny-encoder.mlmodelc.zip
	@cmake -S "$(WHISPER_COREML_DIR)" -B "$(WHISPER_COREML_DIR)/build" \
		-DCMAKE_BUILD_TYPE=Release -DWHISPER_COREML=ON -DGGML_METAL=OFF
	@cmake --build "$(WHISPER_COREML_DIR)/build" --target whisper-server -j 2

whisper:
	@command -v whisper-server >/dev/null && test -f ggml-large-v3-turbo.bin || { \
		echo "Whisper server or large-v3-turbo model missing" >&2; exit 1; \
	}
	@echo "Starting whisper-server on port 8081 with large-v3-turbo + Metal..."
	@whisper-server -m ./ggml-large-v3-turbo.bin --port 8081 -l da -t 2 -bs 1 -bo 1 -nf

whisper-tiny:
	@test -x "$(WHISPER_COREML_SERVER)" && test -f ggml-tiny.bin && \
		test -d ggml-tiny-encoder.mlmodelc || { \
		echo "Core ML tiny model missing; run make whisper-setup first" >&2; exit 1; \
	}
	@echo "Starting whisper-server on port 8081 with tiny + Core ML..."
	@"$(WHISPER_COREML_SERVER)" -m ./ggml-tiny.bin --port 8081 -l da -t 2 -bs 1 -bo 1 -nf
