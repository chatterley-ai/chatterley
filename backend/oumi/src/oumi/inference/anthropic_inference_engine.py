# Copyright 2025 - Oumi
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from typing import Any, Optional

import aiohttp
from typing_extensions import override

from oumi.core.configs import GenerationParams, InferenceConfig, ModelParams, RemoteParams
from oumi.core.types.conversation import Conversation, Message, Role
from oumi.utils.conversation_utils import convert_message_to_json_content_list
from oumi.inference.remote_inference_engine import RemoteInferenceEngine
from oumi.inference.adaptive_semaphore import PoliteAdaptiveSemaphore
from oumi.utils.logging import logger

_CONTENT_KEY: str = "content"
_ROLE_KEY: str = "role"


class AnthropicInferenceEngine(RemoteInferenceEngine):
    """Engine for running inference against the Anthropic API.

    This class extends RemoteInferenceEngine to provide specific functionality
    for interacting with Anthropic's language models via their API. It handles
    the conversion of Oumi's Conversation objects to Anthropic's expected input
    format, as well as parsing the API responses back into Conversation objects.
    """

    anthropic_version = "2023-06-01"
    """The version of the Anthropic API to use.

    For more information on Anthropic API versioning, see:
    https://docs.anthropic.com/claude/reference/versioning
    """

    @property
    @override
    def base_url(self) -> Optional[str]:
        """Return the default base URL for the Anthropic API."""
        return "https://api.anthropic.com/v1/messages"

    @property
    @override
    def api_key_env_varname(self) -> Optional[str]:
        """Return the default environment variable name for the Anthropic API key."""
        return "ANTHROPIC_API_KEY"

    @override
    def _convert_conversation_to_api_input(
        self,
        conversation: Conversation,
        generation_params: GenerationParams,
        model_params: ModelParams,
    ) -> dict[str, Any]:
        """Converts a conversation to an Anthropic API input.

        This method transforms an Oumi Conversation object into a format
        suitable for the Anthropic API. It handles system messages separately
        and structures the conversation history as required by Anthropic.

        See https://docs.anthropic.com/claude/reference/messages_post for details.

        Args:
            conversation: The Oumi Conversation object to convert.
            generation_params: Parameters for text generation.
            model_params: Model parameters to use during inference.

        Returns:
            Dict[str, Any]: A dictionary containing the formatted input for the
            Anthropic API, including the model, messages, and generation parameters.
        """
        system_message: Optional[str] = None
        formatted_messages: list[dict[str, Any]] = []

        message_index = 0
        for message in conversation.messages:
            if message.role == Role.SYSTEM:
                if system_message is None:
                    blocks = convert_message_to_json_content_list(message)
                    text_parts = [
                        block.get("text", "")
                        for block in blocks
                        if isinstance(block, dict) and block.get("type") == "text"
                    ]
                    system_message = "\n".join(part for part in text_parts if part)
                else:
                    logger.warning(
                        "Multiple system messages found; ignoring additional system block."
                    )
                continue

            content_blocks = convert_message_to_json_content_list(message)
            metadata = message.metadata or {}
            additional_blocks = metadata.get("anthropic_documents", [])
            if additional_blocks:
                content_blocks.extend(additional_blocks)

            formatted_messages.append(
                {
                    _ROLE_KEY: message.role.value,
                    _CONTENT_KEY: self._normalize_content_for_anthropic(content_blocks),
                }
            )
            message_index += 1

        # Build request body
        # See https://docs.anthropic.com/claude/reference/messages_post
        body = {
            "model": model_params.model_name,
            "messages": formatted_messages,
            "max_tokens": generation_params.max_new_tokens,
        }

        temperature = generation_params.temperature
        top_p = generation_params.top_p

        if temperature is not None:
            body["temperature"] = temperature
            if top_p is not None:
                logger.debug(
                    "AnthropicInferenceEngine: ignoring top_p=%s because temperature=%s is set",
                    top_p,
                    temperature,
                )
        elif top_p is not None:
            body["top_p"] = top_p

        if system_message:
            body["system"] = system_message

        if generation_params.stop_strings is not None:
            body["stop_sequences"] = generation_params.stop_strings

        anthropic_meta = conversation.metadata.get("anthropic") or {}

        # Debug: log what we received in conversation metadata
        if anthropic_meta:
            logger.debug(
                f"🔍 Anthropic metadata keys: {list(anthropic_meta.keys())}"
            )

        # Handle container (skills) - requires code_execution tool
        if anthropic_meta.get("container"):
            body["container"] = anthropic_meta["container"]

            # Skills API requires code_execution tool to be included
            # See: https://docs.anthropic.com/en/api/skills-guide
            code_execution_tool = {
                "type": "code_execution_20250825",
                "name": "code_execution"
            }

            # Merge with existing tools if present
            existing_tools = anthropic_meta.get("tools", [])
            # Ensure existing_tools is a list
            if not isinstance(existing_tools, list):
                existing_tools = []

            # Check if code_execution tool is already present
            has_code_execution = any(
                isinstance(tool, dict) and tool.get("type") == "code_execution_20250825"
                for tool in existing_tools
            )

            if has_code_execution:
                body["tools"] = existing_tools
            else:
                body["tools"] = [code_execution_tool] + existing_tools

            logger.debug(
                f"🔧 Anthropic Skills API: container present, tools configured: {body.get('tools')}"
            )
        elif anthropic_meta.get("tools"):
            # No container, just use tools as-is
            body["tools"] = anthropic_meta["tools"]

        if anthropic_meta.get("thinking"):
            body["thinking"] = anthropic_meta["thinking"]
        if anthropic_meta.get("betas"):
            body["betas"] = anthropic_meta["betas"]

        # Debug logging for skills API
        if body.get("container") or body.get("tools"):
            logger.debug(
                f"🔍 Anthropic API request body keys: {list(body.keys())}, "
                f"container present: {bool(body.get('container'))}, "
                f"tools present: {bool(body.get('tools'))}, "
                f"tools count: {len(body.get('tools', []))}"
            )

        return body

    @override
    def _convert_api_output_to_conversation(
        self, response: dict[str, Any], original_conversation: Conversation
    ) -> Conversation:
        """Converts an Anthropic API response to a conversation."""
        new_message = Message(
            content=response[_CONTENT_KEY][0]["text"],
            role=Role.ASSISTANT,
        )
        return Conversation(
            messages=[*original_conversation.messages, new_message],
            metadata=original_conversation.metadata,
            conversation_id=original_conversation.conversation_id,
        )

    @override
    def _get_request_headers(self, remote_params: RemoteParams) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "anthropic-version": self.anthropic_version,
            "X-API-Key": self._get_api_key(remote_params) or "",
        }

        # Note: anthropic-beta header should be set dynamically based on actual usage
        # This is a default that will be overridden in _query_api if needed
        return headers

    @override
    async def _query_api(
        self,
        conversation: Conversation,
        semaphore: PoliteAdaptiveSemaphore,
        session: aiohttp.ClientSession,
        inference_config: Optional[InferenceConfig] = None,
    ) -> Conversation:
        """Override to add dynamic beta headers based on conversation metadata."""
        # Get the API input to check what features are being used
        if inference_config is None:
            generation_params = self._generation_params
            model_params = self._model_params
        else:
            generation_params = inference_config.generation or self._generation_params
            model_params = inference_config.model or self._model_params

        api_input = self._convert_conversation_to_api_input(
            conversation, generation_params, model_params
        )

        # Build beta header dynamically based on what's in the request
        betas = api_input.get("betas", [])
        if not betas:
            # Check conversation metadata for betas
            anthropic_meta = conversation.metadata.get("anthropic", {})
            betas = anthropic_meta.get("betas", [])

        # Inject beta header into the session for this request
        if inference_config is None:
            remote_params = self._remote_params
        else:
            remote_params = inference_config.remote_params or self._remote_params

        # Store original headers method
        original_get_headers = self._get_request_headers

        # Temporarily override to add beta header
        def _get_headers_with_beta(rp: RemoteParams) -> dict[str, str]:
            headers = original_get_headers(rp)
            if betas:
                headers["anthropic-beta"] = ",".join(betas)
                logger.debug(f"🔧 Adding anthropic-beta header: {headers['anthropic-beta']}")
            return headers

        # Monkey-patch for this request only
        self._get_request_headers = _get_headers_with_beta  # type: ignore

        try:
            # Call parent implementation
            result = await super()._query_api(
                conversation, semaphore, session, inference_config
            )
            return result
        finally:
            # Restore original method
            self._get_request_headers = original_get_headers  # type: ignore

    @override
    def get_supported_params(self) -> set[str]:
        """Returns a set of supported generation parameters for this engine."""
        return {
            "max_new_tokens",
            "stop_strings",
            "temperature",
            "top_p",
        }

    @override
    def _default_remote_params(self) -> RemoteParams:
        """Returns the default remote parameters."""
        return RemoteParams(num_workers=5, politeness_policy=60.0)

    def _normalize_content_for_anthropic(self, content: Any) -> list[dict[str, Any]]:
        """Convert OpenAI-style content into Anthropic message blocks."""

        if isinstance(content, str):
            return [{"type": "text", "text": content}]

        if not isinstance(content, list):
            return [{"type": "text", "text": str(content) if content is not None else ""}]

        normalized: list[dict[str, Any]] = []
        for part in content:
            if not isinstance(part, dict):
                normalized.append({"type": "text", "text": str(part)})
                continue

            part_type = str(part.get("type", "")).lower()
            if part_type == "text":
                text_value = part.get("text") or part.get("content") or ""
                normalized.append({"type": "text", "text": text_value})
            elif part_type == "image_url":
                normalized.append(
                    self._build_media_block("image", part.get("image_url") or {})
                )
            elif part_type == "audio_url":
                normalized.append(
                    self._build_media_block("audio", part.get("audio_url") or {})
                )
            elif part_type == "video_url":
                normalized.append(
                    self._build_media_block("video", part.get("video_url") or {})
                )
            elif part_type == "document":
                source = part.get("source")
                if isinstance(source, dict) and source.get("type") == "file" and source.get("file_id"):
                    normalized.append(
                        {
                            "type": "document",
                            "source": {
                                "type": "file",
                                "file_id": source["file_id"],
                            },
                        }
                    )
                else:
                    normalized.append({"type": "text", "text": str(part)})
            else:
                normalized.append({"type": "text", "text": str(part)})

        return normalized if normalized else [{"type": "text", "text": ""}]

    def _build_media_block(self, media_type: str, payload: Any) -> dict[str, Any]:
        """Create a Claude-compatible media block from OpenAI-style payloads."""

        url = ""
        if isinstance(payload, dict):
            url = payload.get("url") or payload.get("content") or ""
        elif isinstance(payload, str):
            url = payload

        if not url:
            raise ValueError(f"Missing {media_type} payload for Anthropic request.")

        if url.startswith("data:"):
            header, _, data = url.partition(",")
            media = header.split("data:", 1)[-1].split(";")[0] or self._default_mime(media_type)
            base64_data = data
            return {
                "type": media_type,
                "source": {
                    "type": "base64",
                    "media_type": media,
                    "data": base64_data,
                },
            }

        return {
            "type": media_type,
            "source": {
                "type": "url",
                "url": url,
            },
        }

    @staticmethod
    def _default_mime(media_type: str) -> str:
        if media_type == "audio":
            return "audio/wav"
        if media_type == "video":
            return "video/mp4"
        return "image/png"
