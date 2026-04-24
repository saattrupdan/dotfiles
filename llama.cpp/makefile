start-server:
	@llama-server \
		--models-preset ./preset.ini \
		--models-dir ./ \
		--cache-prompt \
		--ubatch-size 2048 \
		--batch-size 2048 \
		--flash-attn on \
		--cache-type-k q8_0 \
		--cache-type-v q8_0
