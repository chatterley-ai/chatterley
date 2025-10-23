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

from typing_extensions import override

from oumi.core.configs import GenerationParams, ModelParams, RemoteParams
from oumi.core.types.conversation import Conversation, ContentItem, Message, Role
from oumi.inference.remote_inference_engine import RemoteInferenceEngine


class OpenAIInferenceEngine(RemoteInferenceEngine):
    """Engine for running inference against the OpenAI Responses API."""

    @property
    @override
    def base_url(self) -> Optional[str]:
        """Return the default base URL for the OpenAI Responses API."""
        return "https://api.openai.com/v1/responses"

    @property
    @override
    def api_key_env_varname(self) -> Optional[str]:
        """Return the environment variable used for the OpenAI API key."""
        return "OPENAI_API_KEY"

    @override
    def _convert_conversation_to_api_input(
        self,
        conversation: Conversation,
        generation_params: GenerationParams,
        model_params: ModelParams,
    ) -> dict[str, Any]:
        """Converts a conversation into a payload for the Responses API."""

        input_messages: list[dict[str, Any]] = []

        for message in conversation.messages:
            content_blocks: list[dict[str, Any]] = []

            if isinstance(message.content, str):
                if message.content:
                    content_blocks.append(
                        {"type": "input_text", "text": message.content}
                    )
            elif isinstance(message.content, list):
                for item in message.content:
                    if isinstance(item, ContentItem) and item.is_text():
                        content_blocks.append(
                            {"type": "input_text", "text": item.content or ""}
                        )
                    else:
                        item_content = getattr(item, "content", None)
                        if item_content:
                            content_blocks.append(
                                {"type": "input_text", "text": str(item_content)}
                            )

            for file_ref in (message.metadata or {}).get("openai_files", []):
                file_id = file_ref.get("file_id")
                if isinstance(file_id, str) and file_id:
                    content_blocks.append({"type": "input_file", "file_id": file_id})

            if not content_blocks:
                content_blocks.append({"type": "input_text", "text": ""})

            input_messages.append(
                {
                    "role": message.role.value,
                    "content": content_blocks,
                }
            )

        body: dict[str, Any] = {
            "model": model_params.model_name,
            "input": input_messages,
        }

        if generation_params.max_new_tokens is not None:
            body["max_output_tokens"] = generation_params.max_new_tokens
        if generation_params.temperature is not None:
            body["temperature"] = generation_params.temperature
        if generation_params.top_p is not None:
            body["top_p"] = generation_params.top_p

        openai_meta = conversation.metadata.get("openai") if conversation.metadata else None
        if isinstance(openai_meta, dict):
            tools = openai_meta.get("tools")
            if isinstance(tools, list) and tools:
                body["tools"] = tools

            reasoning = openai_meta.get("reasoning")
            if isinstance(reasoning, dict) and reasoning:
                body["reasoning"] = reasoning

        return body

    @override
    def _convert_api_output_to_conversation(
        self, response: dict[str, Any], original_conversation: Conversation
    ) -> Conversation:
        """Converts a Responses API output into a conversation object."""

        text_segments: list[str] = []

        output = response.get("output")
        if isinstance(output, list):
            for item in output:
                if not isinstance(item, dict):
                    continue
                content = item.get("content")
                if isinstance(content, list):
                    for block in content:
                        if (
                            isinstance(block, dict)
                            and block.get("type") in {"output_text", "text"}
                        ):
                            text_segments.append(block.get("text", ""))
                elif isinstance(item.get("text"), str):
                    text_segments.append(item["text"])

        if not text_segments and isinstance(response.get("content"), list):
            for block in response["content"]:
                if (
                    isinstance(block, dict)
                    and block.get("type") in {"output_text", "text"}
                ):
                    text_segments.append(block.get("text", ""))

        if not text_segments and isinstance(response.get("choices"), list):
            first_choice = response["choices"][0] if response["choices"] else {}
            message = first_choice.get("message") or {}
            text_segments.append(str(message.get("content", "")))

        response_text = "".join(text_segments).strip()
        if not response_text:
            response_text = str(response)

        assistant_message = Message(content=response_text, role=Role.ASSISTANT)
        return Conversation(
            messages=[*original_conversation.messages, assistant_message],
            metadata=original_conversation.metadata,
            conversation_id=original_conversation.conversation_id,
        )

    @override
    def _get_request_headers(self, remote_params: RemoteParams) -> dict[str, str]:
        headers = super()._get_request_headers(remote_params)
        headers["Content-Type"] = "application/json"
        return headers

    @override
    def _default_remote_params(self) -> RemoteParams:
        """Returns the default remote parameters."""
        return RemoteParams(num_workers=50, politeness_policy=60.0)
