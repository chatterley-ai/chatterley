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

"""Chat completion endpoints handler for Oumi WebChat server."""

import base64
import copy
import io
import math
import mimetypes
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import aiohttp
from aiohttp import web

from pypdf import PdfReader

from oumi.core.attachments.context_manager import ContextWindowManager
from oumi.core.types.conversation import Conversation, ContentItem, Message, Role, Type
from oumi.utils.logging import logger
from oumi.webchat.core.session_manager import SessionManager
from oumi.webchat.chatgraph_migration.graph_store import GraphStore
from oumi.webchat.protocol import extract_session_id, extract_branch_id
from oumi.webchat.utils.id_utils import generate_message_id
from oumi.webchat.utils.fallbacks import model_name_fallback
from oumi.inference.anthropic_inference_engine import AnthropicInferenceEngine
from oumi.inference.openai_inference_engine import OpenAIInferenceEngine


PDF_TEXT_CHAR_LIMIT = 60000


class AttachmentBudgetError(RuntimeError):
    """Raised when attachments exceed the model's available context budget."""

    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.details: Dict[str, Any] = details or {}


class ChatHandler:
    """Handles chat completion requests for Oumi WebChat."""
    
    def __init__(
        self, 
        session_manager: SessionManager,
        system_prompt: Optional[str] = None,
        db = None,
        enhanced_features_available: bool = False
    ):
        """Initialize chat handler.
        
        Args:
            session_manager: Session manager for WebChat sessions
            system_prompt: Optional system prompt for conversations
            db: Optional WebchatDB instance for persistence
            enhanced_features_available: Whether enhanced API features are available
        """
        self.session_manager = session_manager
        self.system_prompt = system_prompt
        self.db = db
        self.enhanced_features_available = enhanced_features_available
        self.response_formatter = None
        self.request_validator = None
        
        # Initialize enhanced components if available
        if enhanced_features_available:
            try:
                from oumi.webchat.api_responses import ResponseFormatter, RequestValidator
                self.response_formatter = ResponseFormatter()
                self.request_validator = RequestValidator()
            except ImportError:
                logger.warning("Enhanced API components could not be imported")

    def _convert_client_content(self, content: Any) -> Any:
        """Normalizes client-provided message content into Oumi types."""

        if isinstance(content, list):
            items: list[ContentItem] = []

            for part in content:
                if not isinstance(part, dict):
                    continue

                part_type = str(part.get("type", "")).lower()

                def _extract_value(*keys: str) -> Optional[str]:
                    for key in keys:
                        value = part.get(key)
                        if isinstance(value, str) and value:
                            return value
                        if isinstance(value, dict):
                            url = value.get("url")
                            if isinstance(url, str) and url:
                                return url
                    return None

                if part_type == "text":
                    value = _extract_value("content", "text") or ""
                    items.append(ContentItem(type=Type.TEXT, content=value))
                elif part_type == "image_url":
                    value = _extract_value("content", "image_url", "url")
                    if value:
                        items.append(ContentItem(type=Type.IMAGE_URL, content=value))
                elif part_type == "audio_url":
                    value = _extract_value("content", "audio_url", "url")
                    if value:
                        items.append(ContentItem(type=Type.AUDIO_URL, content=value))
                elif part_type == "video_url":
                    value = _extract_value("content", "video_url", "url")
                    if value:
                        items.append(ContentItem(type=Type.VIDEO_URL, content=value))
                elif part_type == "image_path":
                    value = _extract_value("content", "path")
                    if value:
                        items.append(ContentItem(type=Type.IMAGE_PATH, content=value))
                elif part_type == "audio_path":
                    value = _extract_value("content", "path")
                    if value:
                        items.append(ContentItem(type=Type.AUDIO_PATH, content=value))
                elif part_type == "video_path":
                    value = _extract_value("content", "path")
                    if value:
                        items.append(ContentItem(type=Type.VIDEO_PATH, content=value))

            if items:
                return items

            # Fallback: stringify any remaining payload to avoid empty content errors
            return "\n".join(
                str(part) for part in content if part is not None
            )

        if isinstance(content, str):
            return content

        if content is None:
            return ""

        return str(content)

    def _content_items_to_text(self, content: list[ContentItem]) -> str:
        segments: list[str] = []
        for item in content:
            if item.type == Type.TEXT:
                segments.append(item.content or "")
            else:
                segments.append(f"<{item.type.value}>")
        return " ".join(segment for segment in segments if segment)

    async def _prepare_anthropic_context(
        self,
        messages: List[dict[str, Any]],
        engine: AnthropicInferenceEngine,
        settings: Dict[str, Any],
    ) -> Dict[str, Any]:
        message_metadata: Dict[int, dict[str, Any]] = {}
        conversation_metadata: Dict[str, Any] = {}

        if not messages:
            return {
                "message_metadata": message_metadata,
                "conversation_metadata": conversation_metadata,
            }

        enable_files = bool(settings.get("enableFiles", True))
        enable_thinking = bool(settings.get("enableThinking", False))
        thinking_budget = int(settings.get("thinkingBudgetTokens", 6000))
        enable_web_search = bool(settings.get("enableWebSearch", False))
        web_search_max = int(settings.get("webSearchMaxUses", 5))

        tools: list[dict[str, Any]] = []

        context_manager: Optional[ContextWindowManager] = None
        available_attachment_tokens: Optional[int] = None
        total_attachment_tokens = 0
        attachment_breakdown: list[dict[str, Any]] = []
        conversation_token_estimate = 0

        max_context_length: Optional[int] = None
        model_name: Optional[str] = None
        if hasattr(engine, "_model_params") and engine._model_params is not None:
            max_context_length = getattr(engine._model_params, "model_max_length", None)
            model_name = getattr(engine._model_params, "model_name", None)

        if max_context_length:
            context_manager = ContextWindowManager(max_context_length, model_name or "anthropic")
            try:
                conversation_token_estimate = sum(
                    self._estimate_message_token_usage(msg, context_manager)
                    for msg in messages
                )
            except Exception:  # pragma: no cover - defensive estimation
                conversation_token_estimate = 0

            try:
                budget = context_manager.calculate_budget(conversation_token_estimate)
                available_attachment_tokens = budget.available_for_content
            except Exception:  # pragma: no cover - defensive budget calc
                available_attachment_tokens = None

        for idx, message in enumerate(messages):
            attachments = message.get("attachments")
            if not attachments or not isinstance(attachments, list):
                continue

            if not enable_files:
                logger.debug(
                    "Skipping %d attachment(s) for message %d because files support is disabled",
                    len(attachments),
                    idx,
                )
                continue

            document_blocks: list[dict[str, Any]] = []
            for attachment in attachments:
                if not isinstance(attachment, dict):
                    continue

                name = str(attachment.get("name") or "")
                mime_type = str(attachment.get("mimeType") or "").lower()
                is_pdf = "pdf" in mime_type or name.lower().endswith(".pdf")

                base64_data: Optional[str] = None
                text_content: Optional[str] = None
                url_source: Optional[str] = None

                base64_blob = attachment.get("base64")
                if isinstance(base64_blob, str) and base64_blob:
                    base64_data = base64_blob

                if base64_data is None:
                    data_url = attachment.get("dataUrl")
                    if isinstance(data_url, str) and data_url.startswith("data:"):
                        header, _, encoded = data_url.partition(",")
                        if encoded:
                            base64_data = encoded
                            if not mime_type:
                                try:
                                    mime_type = header.split(":", 1)[1].split(";", 1)[0].lower()
                                except Exception:
                                    mime_type = ""

                if base64_data is not None and is_pdf:
                    try:
                        pdf_bytes = base64.b64decode(base64_data, validate=False)
                        reader = PdfReader(io.BytesIO(pdf_bytes))
                        extracted_pages: list[str] = []
                        for page_index, page in enumerate(reader.pages):
                            try:
                                page_text = page.extract_text() or ""
                            except Exception as page_error:  # pragma: no cover - defensive
                                logger.debug(
                                    "Failed to extract text from PDF page %d (%s): %s",
                                    page_index,
                                    name,
                                    page_error,
                                )
                                page_text = ""
                            if page_text:
                                extracted_pages.append(page_text)
                        extracted_text = "\n\n".join(extracted_pages).strip()
                        if extracted_text:
                            if len(extracted_text) > PDF_TEXT_CHAR_LIMIT:
                                logger.warning(
                                    "Truncating extracted PDF text for %s from %d to %d characters",
                                    name or "attachment",
                                    len(extracted_text),
                                    PDF_TEXT_CHAR_LIMIT,
                                )
                                extracted_text = extracted_text[:PDF_TEXT_CHAR_LIMIT]
                            text_content = extracted_text
                            base64_data = None
                    except Exception as extraction_error:  # pragma: no cover - defensive
                        logger.warning(
                            "Failed to extract text from PDF %s: %s",
                            name or "attachment",
                            extraction_error,
                        )

                if base64_data is None:
                    raw_text = attachment.get("textContent")
                    if isinstance(raw_text, str) and raw_text.strip():
                        text_content = raw_text

                if base64_data is None and text_content is None:
                    potential_url = attachment.get("url") or attachment.get("sourceUrl")
                    if isinstance(potential_url, str) and potential_url:
                        url_source = potential_url

                document_block: Optional[dict[str, Any]] = None
                if text_content is not None:
                    document_block = {
                        "type": "document",
                        "source": {
                            "type": "text",
                            "text": text_content,
                        },
                    }
                elif base64_data is not None:
                    media_type = mime_type or "application/octet-stream"
                    document_block = {
                        "type": "document",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": base64_data,
                        },
                    }
                elif url_source is not None:
                    document_block = {
                        "type": "document",
                        "source": {
                            "type": "url",
                            "url": url_source,
                        },
                    }
                else:
                    logger.warning(
                        "Unsupported attachment for Anthropic upload (name=%s, mime=%s); skipping",
                        name,
                        mime_type or "unknown",
                    )
                    continue

                if name:
                    document_block["title"] = name

                if context_manager is not None:
                    source = document_block.get("source", {})
                    source_type = source.get("type")
                    approx_tokens: Optional[int] = None
                    approx_size: Optional[int] = None
                    if source_type == "text":
                        text_payload = source.get("text", "")
                        approx_tokens = context_manager.estimate_tokens(text_payload)
                        approx_size = len(text_payload)
                    elif source_type == "base64":
                        data_payload = source.get("data", "")
                        approx_size = int(len(data_payload) * 0.75)
                        approx_tokens = max(1, approx_size // 4)
                    elif source_type == "url":
                        approx_tokens = 0

                    if approx_tokens is not None and approx_tokens > 0:
                        projected_total = total_attachment_tokens + approx_tokens
                        attachment_entry = {
                            "name": name or "attachment",
                            "tokens": approx_tokens,
                            "size_bytes": approx_size,
                        }
                        attachment_breakdown.append(attachment_entry)
                        if (
                            available_attachment_tokens is not None
                            and projected_total > available_attachment_tokens
                        ):
                            raise AttachmentBudgetError(
                                (
                                    "Attachment '{name}' is estimated to add ~{attachment_tokens:,} tokens; "
                                    "combined attachments would require ~{projected_total:,} tokens but the "
                                    "model {model} reserves ~{available:,} tokens for attachments."
                                ).format(
                                    name=attachment_entry["name"],
                                    attachment_tokens=approx_tokens,
                                    projected_total=projected_total,
                                    available=available_attachment_tokens,
                                    model=model_name or "Anthropic",
                                ),
                                {
                                    "model": model_name or "anthropic",
                                    "conversation_tokens_estimate": conversation_token_estimate,
                                    "attachment_tokens_estimate": projected_total,
                                    "attachment_budget_tokens": available_attachment_tokens,
                                    "attachments": attachment_breakdown,
                                },
                            )
                        total_attachment_tokens = projected_total

                document_blocks.append(document_block)

            if document_blocks:
                message_metadata.setdefault(idx, {})["anthropic_documents"] = document_blocks

            if enable_web_search:
                tools.append(
                    {
                        "type": "web_search_20250305",
                        "name": "web_search",
                        "max_uses": max(1, min(10, web_search_max)),
                    }
                )

            if tools:
                conversation_metadata["tools"] = tools

            # Anthropic betas are communicated via request headers; including them in the
            # payload triggers validation errors like "Extra inputs are not permitted".
            # We therefore avoid attaching the betas list to the request body and rely on
            # the headers configured by the inference engine instead.

            if enable_thinking:
                conversation_metadata["thinking"] = {
                    "type": "enabled",
                    "budget_tokens": max(1000, thinking_budget),
                }

        return {
            "message_metadata": message_metadata,
            "conversation_metadata": conversation_metadata,
        }

    async def _prepare_openai_context(
        self,
        messages: List[dict[str, Any]],
        engine: OpenAIInferenceEngine,
        settings: Dict[str, Any],
    ) -> Dict[str, Any]:
        message_metadata: Dict[int, Dict[str, Any]] = {}
        conversation_metadata: Dict[str, Any] = {}

        context_manager: Optional[ContextWindowManager] = None
        available_attachment_tokens: Optional[int] = None
        total_attachment_tokens = 0
        attachment_breakdown: list[Dict[str, Any]] = []
        conversation_token_estimate = 0
        max_context_length: Optional[int] = None
        model_name: Optional[str] = None

        if hasattr(engine, "_model_params") and engine._model_params is not None:
            max_context_length = getattr(engine._model_params, "model_max_length", None)
            model_name = getattr(engine._model_params, "model_name", None)

        if max_context_length:
            context_manager = ContextWindowManager(max_context_length, model_name or "openai")
            try:
                conversation_token_estimate = sum(
                    self._estimate_message_token_usage(message, context_manager)
                    for message in messages
                )
            except Exception:  # pragma: no cover - defensive token estimation
                conversation_token_estimate = 0

            try:
                budget = context_manager.calculate_budget(conversation_token_estimate)
                available_attachment_tokens = budget.available_for_content
            except Exception:  # pragma: no cover - defensive budget calc
                available_attachment_tokens = None

        if not messages:
            return {
                "message_metadata": message_metadata,
                "conversation_metadata": conversation_metadata,
            }

        enable_files = bool(settings.get("enableFiles", True))
        enable_web_search = bool(settings.get("enableWebSearch", False))
        enable_deep_research = bool(settings.get("enableDeepResearch", False))
        deep_research_effort = settings.get("deepResearchEffort", "medium")
        enable_pdf_uploads = bool(settings.get("enablePdfUploads", True))

        tools: list[dict[str, Any]] = []

        upload_session: Optional[aiohttp.ClientSession] = None
        try:
            attachment_upload_types: dict[tuple[int, int], bool] = {}
            should_upload_any = False

            for msg_idx, message in enumerate(messages):
                attachments = message.get("attachments")
                if not attachments or not isinstance(attachments, list):
                    continue

                for att_idx, attachment in enumerate(attachments):
                    if not isinstance(attachment, dict):
                        continue

                    mime_type = str(attachment.get("mimeType") or "").lower()
                    name = str(attachment.get("name") or "")
                    extension = Path(name).suffix.lower()

                    is_pdf = "pdf" in mime_type or extension == ".pdf"
                    should_upload = bool(enable_pdf_uploads and is_pdf)

                    attachment_upload_types[(msg_idx, att_idx)] = should_upload
                    if should_upload:
                        should_upload_any = True

            if should_upload_any:
                timeout = aiohttp.ClientTimeout(
                    total=getattr(engine._remote_params, "connection_timeout", 300.0)
                    or 300.0
                )
                upload_session = aiohttp.ClientSession(timeout=timeout)

            file_reference_token_cost = 0

            for idx, message in enumerate(messages):
                attachments = message.get("attachments")
                if not attachments or not isinstance(attachments, list):
                    continue

                file_refs: list[dict[str, Any]] = []
                for att_idx, attachment in enumerate(attachments):
                    if not isinstance(attachment, dict):
                        continue

                    file_id = attachment.get("fileId")
                    mime_type = str(attachment.get("mimeType") or "").lower()
                    should_upload = attachment_upload_types.get((idx, att_idx), False)

                    include_in_budget = (file_id is not None) or should_upload

                    approx_tokens: Optional[int] = None
                    approx_size: Optional[int] = None
                    if include_in_budget and context_manager is not None:
                        if file_id or should_upload:
                            approx_tokens = file_reference_token_cost
                            approx_size = None

                            size_field = attachment.get("size")
                            if isinstance(size_field, (int, float)) and size_field > 0:
                                approx_size = int(size_field)
                            else:
                                prior_size = attachment.get("approxSizeBytes")
                                if isinstance(prior_size, (int, float)):
                                    approx_size = int(prior_size)

                            attachment["approxTokenEstimate"] = approx_tokens
                            if approx_size is not None:
                                attachment["approxSizeBytes"] = approx_size
                        else:
                            approx_tokens, approx_size = self._estimate_attachment_cost(
                                attachment,
                                context_manager,
                            )

                        if approx_tokens is None:
                            approx_tokens = 0

                        projected_total = total_attachment_tokens + approx_tokens
                        attachment_entry = {
                            "name": attachment.get("name")
                            or attachment.get("fileId")
                            or "attachment",
                            "tokens": approx_tokens,
                            "size_bytes": approx_size,
                        }
                        attachment_breakdown.append(attachment_entry)
                        if (
                            available_attachment_tokens is not None
                            and projected_total > available_attachment_tokens
                        ):
                            raise AttachmentBudgetError(
                                (
                                    "Attachment '{name}' is estimated to add ~{attachment_tokens:,} tokens; "
                                    "combined attachments would require ~{projected_total:,} tokens but the "
                                    "model {model} reserves ~{available:,} tokens for file context."
                                ).format(
                                    name=attachment_entry["name"],
                                    attachment_tokens=approx_tokens,
                                    projected_total=projected_total,
                                    available=available_attachment_tokens,
                                    model=model_name or "OpenAI",
                                ),
                                {
                                    "model": model_name or "openai",
                                    "max_context_tokens": max_context_length,
                                    "conversation_tokens_estimate": conversation_token_estimate,
                                    "attachment_tokens_estimate": projected_total,
                                    "attachment_budget_tokens": available_attachment_tokens,
                                    "attachments": attachment_breakdown,
                                },
                            )
                        total_attachment_tokens = projected_total

                    if should_upload and not file_id and upload_session is not None:
                        try:
                            file_id = await self._upload_openai_file(
                                upload_session, engine, attachment
                            )
                        except Exception as exc:  # pragma: no cover - best effort
                            logger.warning(
                                "Failed to upload attachment '%s' to OpenAI Files API: %s",
                                attachment.get("name"),
                                exc,
                            )
                            file_id = None

                        if file_id:
                            attachment["fileId"] = file_id
                            attachment.pop("base64", None)
                            attachment.pop("dataUrl", None)
                            attachment.pop("textContent", None)

                    if file_id:
                        file_refs.append(
                            {
                                "file_id": file_id,
                                "mime_type": attachment.get("mimeType"),
                                "name": attachment.get("name"),
                            }
                        )

                if file_refs:
                    message_metadata[idx] = {"openai_files": file_refs}

        finally:
            if upload_session is not None:
                await upload_session.close()

        openai_meta: Dict[str, Any] = {}
        if context_manager is not None and attachment_breakdown:
            logger.debug(
                "📏 OpenAI attachment budget check: estimated attachment tokens=%s, available=%s, conversation tokens=%s",
                total_attachment_tokens,
                available_attachment_tokens,
                conversation_token_estimate,
            )
            openai_meta.setdefault(
                "attachment_context_usage",
                {
                    "total_attachment_tokens": total_attachment_tokens,
                    "available_attachment_tokens": available_attachment_tokens,
                    "conversation_tokens_estimate": conversation_token_estimate,
                    "max_context_tokens": max_context_length,
                    "attachments": attachment_breakdown,
                },
            )
        if enable_web_search:
            tools.append({"type": "web_search"})
        if tools:
            openai_meta["tools"] = tools
        if enable_deep_research:
            openai_meta["reasoning"] = {
                "effort": deep_research_effort if deep_research_effort else "medium"
            }

        if openai_meta:
            conversation_metadata = openai_meta

        return {
            "message_metadata": message_metadata,
            "conversation_metadata": conversation_metadata,
        }

    async def _upload_anthropic_file(
        self,
        session: aiohttp.ClientSession,
        engine: AnthropicInferenceEngine,
        attachment: Dict[str, Any],
    ) -> Optional[str]:
        api_key = engine._get_api_key(engine._remote_params)
        if not api_key:
            logger.warning("Anthropic API key not available; cannot upload attachment.")
            return None

        payload = self._extract_attachment_payload(attachment)
        if payload is None:
            return None
        data_bytes, filename, mime_type = payload

        form = aiohttp.FormData()
        form.add_field("file", data_bytes, filename=filename, content_type=mime_type)

        headers = {
            "x-api-key": api_key,
            "anthropic-version": engine.anthropic_version,
            "anthropic-beta": "files-api-2025-04-14",
        }

        upload_url = "https://api.anthropic.com/v1/files"
        async with session.post(upload_url, data=form, headers=headers) as response:
            if response.status >= 400:
                body = await response.text()
                raise RuntimeError(
                    f"Anthropic file upload failed with status {response.status}: {body}"
                )
            payload = await response.json()
            return payload.get("id")

    async def _upload_openai_file(
        self,
        session: aiohttp.ClientSession,
        engine: OpenAIInferenceEngine,
        attachment: Dict[str, Any],
    ) -> Optional[str]:
        api_key = engine._get_api_key(engine._remote_params)
        if not api_key:
            logger.warning("OpenAI API key not available; cannot upload attachment.")
            return None

        payload = self._extract_attachment_payload(attachment)
        if payload is None:
            return None
        data_bytes, filename, mime_type = payload

        attachment["approxSizeBytes"] = len(data_bytes)
        attachment.setdefault(
            "approxTokenEstimate", max(1, math.ceil(len(data_bytes) / 4))
        )

        form = aiohttp.FormData()
        form.add_field("purpose", "assistants")
        form.add_field("file", data_bytes, filename=filename, content_type=mime_type)

        headers = {
            "Authorization": f"Bearer {api_key}",
        }

        upload_url = "https://api.openai.com/v1/files"
        async with session.post(upload_url, data=form, headers=headers) as response:
            if response.status >= 400:
                body = await response.text()
                raise RuntimeError(
                    f"OpenAI file upload failed with status {response.status}: {body}"
                )
            payload = await response.json()
            return payload.get("id")

    def _extract_attachment_payload(
        self, attachment: Dict[str, Any]
    ) -> Optional[tuple[bytes, str, str]]:
        name = attachment.get("name")
        if not isinstance(name, str) or not name:
            name = f"attachment-{uuid.uuid4().hex[:8]}"

        mime_type = attachment.get("mimeType")
        if not isinstance(mime_type, str) or not mime_type:
            mime_type = None

        data_bytes: Optional[bytes] = None

        data_url = attachment.get("dataUrl")
        if isinstance(data_url, str) and data_url.startswith("data:"):
            header, _, encoded = data_url.partition(",")
            if encoded:
                try:
                    if ";base64" in header:
                        data_bytes = base64.b64decode(encoded)
                    else:
                        data_bytes = encoded.encode("utf-8")
                except Exception:  # pragma: no cover - defensive
                    data_bytes = None
            if mime_type is None and ":" in header:
                try:
                    mime_type = header.split(":", 1)[1].split(";", 1)[0]
                except Exception:
                    mime_type = None

        if data_bytes is None:
            base64_blob = attachment.get("base64")
            if isinstance(base64_blob, str) and base64_blob:
                try:
                    data_bytes = base64.b64decode(base64_blob)
                except Exception:
                    data_bytes = None

        if data_bytes is None:
            text_content = attachment.get("textContent") or attachment.get("fetchContent")
            if isinstance(text_content, str):
                data_bytes = text_content.encode("utf-8")
                if mime_type is None:
                    mime_type = "text/plain"

        if data_bytes is None:
            return None

        if mime_type is None:
            mime_type = mimetypes.guess_type(name)[0] or "application/octet-stream"

        return data_bytes, name, mime_type

    @staticmethod
    def _infer_anthropic_skill(attachment: Dict[str, Any]) -> Optional[str]:
        mime_type = str(attachment.get("mimeType") or "").lower()
        name = str(attachment.get("name") or "")
        extension = Path(name).suffix.lower()

        mapping = {
            ".ppt": "pptx",
            ".pptx": "pptx",
            ".pps": "pptx",
            ".ppsx": "pptx",
            ".xls": "xlsx",
            ".xlsx": "xlsx",
            ".csv": "xlsx",
            ".doc": "docx",
            ".docx": "docx",
            ".pdf": "pdf",
        }

        if extension in mapping:
            return mapping[extension]

        if "pdf" in mime_type:
            return "pdf"
        if "spreadsheet" in mime_type or "excel" in mime_type:
            return "xlsx"
        if "presentation" in mime_type:
            return "pptx"
        if "word" in mime_type or "document" in mime_type:
            return "docx"

        return None

    def _estimate_attachment_cost(
        self,
        attachment: Dict[str, Any],
        context_manager: Optional[ContextWindowManager],
    ) -> tuple[Optional[int], Optional[int]]:
        """Estimate token and byte cost for an attachment.

        Args:
            attachment: Attachment metadata dictionary.
            context_manager: Optional context manager with tokenizer support.

        Returns:
            Tuple of (estimated_tokens, estimated_size_bytes). Either value may be None
            if it cannot be approximated.
        """

        text_source = None
        for key in ("textContent", "fetchContent"):
            value = attachment.get(key)
            if isinstance(value, str) and value:
                text_source = value
                break

        if text_source is not None:
            estimated_tokens = (
                context_manager.estimate_tokens(text_source)
                if context_manager is not None
                else max(1, math.ceil(len(text_source) / 4))
            )
            size_bytes = len(text_source.encode("utf-8"))
            attachment.setdefault("approxTokenEstimate", estimated_tokens)
            attachment.setdefault("approxSizeBytes", size_bytes)
            return estimated_tokens, size_bytes

        size_field = attachment.get("size")
        if isinstance(size_field, (int, float)) and size_field > 0:
            size_bytes = int(size_field)
            estimated_tokens = max(1, math.ceil(size_bytes / 4))
            attachment.setdefault("approxTokenEstimate", estimated_tokens)
            attachment.setdefault("approxSizeBytes", size_bytes)
            return estimated_tokens, size_bytes

        base64_blob = attachment.get("base64")
        if isinstance(base64_blob, str) and base64_blob:
            # Approximate decoded byte length from base64 payload
            size_bytes = int(len(base64_blob) * 0.75)
            estimated_tokens = max(1, math.ceil(size_bytes / 4))
            attachment.setdefault("approxTokenEstimate", estimated_tokens)
            attachment.setdefault("approxSizeBytes", size_bytes)
            return estimated_tokens, size_bytes

        data_url = attachment.get("dataUrl")
        if isinstance(data_url, str) and "base64," in data_url:
            _, _, encoded = data_url.partition("base64,")
            if encoded:
                size_bytes = int(len(encoded) * 0.75)
                estimated_tokens = max(1, math.ceil(size_bytes / 4))
                attachment.setdefault("approxTokenEstimate", estimated_tokens)
                attachment.setdefault("approxSizeBytes", size_bytes)
                return estimated_tokens, size_bytes

        approx_tokens = attachment.get("approxTokenEstimate")
        approx_size = attachment.get("approxSizeBytes")
        if isinstance(approx_tokens, (int, float)):
            estimated_tokens = int(math.ceil(approx_tokens))
            size_bytes = (
                int(math.ceil(approx_size))
                if isinstance(approx_size, (int, float))
                else None
            )
            return estimated_tokens, size_bytes

        return None, None

    def _estimate_message_token_usage(
        self,
        message: Dict[str, Any],
        context_manager: ContextWindowManager,
    ) -> int:
        """Estimate token usage for a message's textual content."""

        content = message.get("content")
        if isinstance(content, str):
            return context_manager.estimate_tokens(content)

        if isinstance(content, list):
            total = 0
            for part in content:
                if not isinstance(part, dict):
                    continue
                part_type = str(part.get("type", "")).lower()
                if part_type in {"text", "input_text"}:
                    value = part.get("content") or part.get("text") or part.get("value")
                    if isinstance(value, str) and value:
                        total += context_manager.estimate_tokens(value)
            return total

        if content is None:
            return 0

        return context_manager.estimate_tokens(str(content))

    async def handle_chat_completions(self, request: web.Request) -> web.Response:
        """Handle chat completions requests in OpenAI format.
        
        Args:
            request: Web request with chat completion parameters
            
        Returns:
            JSON response with completion result
        """
        try:
            data = await request.json()
        except Exception as e:
            return web.json_response(
                {
                    "error": {
                        "message": f"Invalid JSON: {str(e)}",
                        "type": "invalid_request_error",
                    }
                },
                status=400,
            )
        
        # Extract required fields
        messages = data.get("messages", [])
        if not messages:
            return web.json_response(
                {
                    "error": {
                        "message": "messages field is required",
                        "type": "invalid_request_error",
                    }
                },
                status=400,
            )
        
        # Extract optional fields
        model = data.get("model", model_name_fallback("request.model"))
        temperature = data.get("temperature", 1.0)
        max_tokens = data.get("max_tokens", 100)
        stream = data.get("stream", False)
        
        # Extract session_id and branch_id with consistent handling
        # We don't require these parameters as this endpoint can work without a session
        session_id = extract_session_id(None, data, required=False)  # WebChat session ID
        branch_id = data.get("branch_id")  # Target branch ID for this chat request
        
        try:
            # Convert OpenAI format messages to Oumi conversation format
            oumi_messages = []
            
            # Add system prompt if provided
            if self.system_prompt:
                oumi_messages.append(
                    Message(role=Role.SYSTEM, content=self.system_prompt)
                )
            
            # Convert messages
            for msg in messages:
                role_mapping = {
                    "system": Role.SYSTEM,
                    "user": Role.USER,
                    "assistant": Role.ASSISTANT,
                }
                role = role_mapping.get(msg.get("role"), Role.USER)
                raw_content = msg.get("content", "")
                normalized_content = self._convert_client_content(raw_content)
                oumi_messages.append(Message(role=role, content=normalized_content))
            
            # Get the latest user message for inference
            user_messages = [msg for msg in messages if msg.get("role") == "user"]
            if not user_messages:
                return web.json_response(
                    {
                        "error": {
                            "message": "No user message found",
                            "type": "invalid_request_error",
                        }
                    },
                    status=400,
                )
            
            latest_user_raw = user_messages[-1].get("content", "")
            latest_user_content = self._convert_client_content(latest_user_raw)
            latest_user_text = (
                self._content_items_to_text(latest_user_content)
                if isinstance(latest_user_content, list)
                else str(latest_user_content)
            )
            
            # CRITICAL: If we have a session_id, use the session for branch-aware chat
            if session_id:
                async def handle_branch_aware_chat(session):
                    """Handle branch-aware chat completion within session lock."""
                    # Use local variable to avoid UnboundLocalError
                    effective_branch_id = branch_id
                    
                    # Handle branch switching if branch_id provided
                    if effective_branch_id and effective_branch_id != session.branch_manager.current_branch_id:
                        logger.debug(f"🌿 Chat request targeting branch '{effective_branch_id}', current: '{session.branch_manager.current_branch_id}'")
                        
                        # Save current conversation to current branch
                        current_branch = session.branch_manager.get_current_branch()
                        current_branch.conversation_history = copy.deepcopy(session.conversation_history)
                        current_branch.last_active = time.time()
                        logger.debug(f"🔄 Saved {len(session.conversation_history)} messages to branch '{session.branch_manager.current_branch_id}'")
                        
                        # Switch to target branch and load its conversation
                        if effective_branch_id in session.branch_manager.branches:
                            target_branch = session.branch_manager.branches[effective_branch_id]
                            session.branch_manager.current_branch_id = effective_branch_id
                            
                            # Load target branch conversation into session
                            session.conversation_history.clear()
                            session.conversation_history.extend(target_branch.conversation_history)
                            target_branch.last_active = time.time()
                            logger.debug(f"🔄 Loaded {len(session.conversation_history)} messages from branch '{effective_branch_id}'")
                        else:
                            logger.error(f"🚨 Target branch '{effective_branch_id}' not found, staying on current branch")
                            effective_branch_id = session.branch_manager.current_branch_id  # Reset to current
                    elif effective_branch_id:
                        logger.debug(f"🌿 Chat request already on target branch '{effective_branch_id}'")
                    else:
                        # Use current branch if no branch_id specified
                        effective_branch_id = session.branch_manager.current_branch_id
                        logger.debug(f"🌿 Chat request using current branch '{effective_branch_id}' (no branch_id specified)")
                    
                    # Create a snapshot of conversation history for consistency
                    conversation_snapshot = copy.deepcopy(session.conversation_history)
                    
                    return session, effective_branch_id, conversation_snapshot
                
                # Use atomic operation for branch switching
                session, effective_branch_id, conversation_snapshot = await self.session_manager.execute_session_operation(
                    session_id, 
                    handle_branch_aware_chat
                )
                
                # Update branch_id to the one actually used
                branch_id = effective_branch_id 
                
                # Get the current inference engine and config from the session
                session_config = session.config
                session_engine = session.inference_engine
                
                # Use swapped engine/config if available
                if hasattr(session.command_context, 'config') and session.command_context.config:
                    session_config = session.command_context.config
                    logger.debug(f"🔄 Using session's swapped config: {getattr(session_config.model, 'model_name', 'Unknown')}")
                
                if hasattr(session.command_context, 'inference_engine') and session.command_context.inference_engine:
                    session_engine = session.command_context.inference_engine
                    logger.debug(f"🔄 Using session's swapped inference engine")

                if not session_engine or not hasattr(session_engine, "infer"):
                    engine_error = getattr(session, "inference_engine_error", None)
                    error_details = (
                        f"Inactive inference engine for session {session.session_id}"
                        if not engine_error
                        else f"Inactive inference engine for session {session.session_id}: {engine_error}"
                    )
                    raise RuntimeError(error_details)

            else:
                # Fallback: create a simple conversation with just the latest message
                # Use the session manager's default config and create a temporary engine
                from oumi.infer import get_engine
                session_config = self.session_manager.default_config
                session_engine = get_engine(session_config)
                if not session_engine or not hasattr(session_engine, "infer"):
                    raise RuntimeError(
                        "Failed to initialize inference engine for ad-hoc chat request"
                    )
                logger.debug(f"🧠 No session context, using single message conversation")

            if session_id:
                messages_for_context = messages
            else:
                messages_for_context = [messages[-1]] if messages else []

            anthropic_context: Optional[dict[str, Any]] = None
            if (
                isinstance(session_engine, AnthropicInferenceEngine)
                and messages_for_context
            ):
                anthropic_settings = data.get("anthropic_settings") or {}
                anthropic_context = await self._prepare_anthropic_context(
                    messages_for_context,
                    session_engine,
                    anthropic_settings,
                )

            openai_context: Optional[dict[str, Any]] = None
            if (
                isinstance(session_engine, OpenAIInferenceEngine)
                and messages_for_context
            ):
                openai_settings = data.get("openai_settings") or {}
                try:
                    openai_context = await self._prepare_openai_context(
                        messages_for_context,
                        session_engine,
                        openai_settings,
                    )
                except AttachmentBudgetError as exc:
                    logger.warning("Attachment exceeds context budget: %s", exc)
                    details = getattr(exc, "details", {})
                    return web.json_response(
                        {
                            "error": {
                                "message": str(exc),
                                "type": "context_window_limit",
                                "details": details,
                            }
                        },
                        status=413,
                    )

            merged_message_metadata: dict[int, dict[str, Any]] = {}
            if anthropic_context and anthropic_context.get("message_metadata"):
                for idx, meta in anthropic_context["message_metadata"].items():
                    merged_message_metadata.setdefault(idx, {}).update(meta)
            if openai_context and openai_context.get("message_metadata"):
                for idx, meta in openai_context["message_metadata"].items():
                    merged_message_metadata.setdefault(idx, {}).update(meta)

            conversation_metadata: dict[str, Any] = {}
            if anthropic_context and anthropic_context.get("conversation_metadata"):
                conversation_metadata["anthropic"] = anthropic_context["conversation_metadata"]
            if openai_context and openai_context.get("conversation_metadata"):
                conversation_metadata["openai"] = openai_context["conversation_metadata"]

            conversation_messages: list[Message] = []
            if self.system_prompt:
                conversation_messages.append(
                    Message(role=Role.SYSTEM, content=self.system_prompt)
                )

            for idx, raw_message in enumerate(messages_for_context):
                role_mapping = {
                    "system": Role.SYSTEM,
                    "user": Role.USER,
                    "assistant": Role.ASSISTANT,
                }
                role = role_mapping.get(raw_message.get("role"), Role.USER)
                normalized_content = self._convert_client_content(
                    raw_message.get("content", "")
                )
                message_metadata = merged_message_metadata.get(idx, {})
                conversation_messages.append(
                    Message(
                        role=role,
                        content=normalized_content,
                        metadata=message_metadata,
                    )
                )

            full_conversation = Conversation(
                messages=conversation_messages,
                metadata=conversation_metadata,
            )

            # Determine the effective model name actually used for this request
            try:
                effective_model_name = getattr(session_config.model, 'model_name', None)
            except Exception:
                effective_model_name = None
            if not effective_model_name:
                effective_model_name = model_name_fallback("session_config.model.model_name")

            # CRITICAL FIX: Use the SAME proven logic as "oumi chat" command
            # This is the battle-tested approach that works with all engine types
            try:
                logger.info(f"🧠 Starting inference with {session_config.engine} engine")
                logger.info(f"🧠 Conversation has {len(full_conversation.messages)} messages")
                logger.info(f"🧠 Model: {getattr(session_config.model, 'model_name', 'Unknown')}")
                
                # Log conversation content for debugging
                for i, msg in enumerate(full_conversation.messages):
                    logger.debug(f"Message {i}: {msg.role} - {str(msg.content)[:100]}...")
                
                logger.info(f"🚀 Calling inference_engine.infer() with {session_config.engine} engine")
                for idx, cmsg in enumerate(full_conversation.messages):
                    logger.debug(
                        "[infer] Conversation message %d role=%s type=%s", 
                        idx,
                        cmsg.role,
                        type(cmsg.content),
                    )
                    if isinstance(cmsg.content, list):
                        for part_idx, part in enumerate(cmsg.content):
                            logger.debug(
                                "[infer]   part %d -> type=%s content=%s",
                                part_idx,
                                getattr(part, 'type', None),
                                getattr(part, 'content', None)[:60] if getattr(part, 'content', None) else None,
                            )
                start_time = time.time()
                
                # Use the same inference engine interface as oumi chat command
                model_response = session_engine.infer(
                    input=[full_conversation],  # List containing one conversation object
                    inference_config=session_config,
                )
                
                elapsed = time.time() - start_time
                logger.info(f"✅ inference_engine.infer() completed in {elapsed:.2f} seconds")
                
                # Extract the response using the same logic as oumi chat
                response_content = ""
                if model_response:
                    # Get the last conversation from the response
                    last_conversation = model_response[-1] if isinstance(model_response, list) else model_response
                    
                    # Find the assistant's response in reverse order (most recent first)
                    for message in reversed(last_conversation.messages):
                        if message.role == Role.ASSISTANT and isinstance(message.content, str):
                            response_content = message.content
                            break
                
                if not response_content:
                    response_content = "No response generated"
                    
                logger.debug(f"✅ Got response from inference engine: {len(response_content)} chars")
                
            except Exception as e:
                logger.error("❌ Inference engine call failed: %s", e)
                logger.exception(e)
                raise
            
            # Check if we have a valid response
            if not response_content or response_content.startswith("Inference failed:"):
                msg = response_content or "No response generated"
                return web.json_response(
                    {
                        "message": msg,
                        "error": {
                            "message": msg,
                            "type": "server_error",
                        }
                    },
                    status=500,
                )
            
            # Format response in OpenAI format
            response_data = {
                "id": f"chatcmpl-{int(time.time())}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": effective_model_name,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": response_content},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": len(latest_user_text.split()),
                    "completion_tokens": len(response_content.split()),
                    "total_tokens": len(latest_user_text.split()) + len(response_content.split()),
                },
            }
            
            # Update WebChat session if session_id provided
            if session_id:
                logger.info(
                    f"🔍 Updating WebChat session {session_id} from OpenAI API (branch: {branch_id})"
                )
                
                async def update_conversation_with_branch(session):
                    """Update conversation for the active branch without trusting stale client history.

                    Rules:
                    - If this is a fresh session (no history yet), seed from client messages once.
                    - Otherwise, append only the latest user message from the request, then the assistant reply.
                    - Keep the active branch sharing the SAME list object as the session for integrity.
                    """
                    is_fresh_session = len(session.conversation_history) == 0

                    if is_fresh_session:
                        # Seed the new session with client-provided messages (first request only)
                        session.conversation_history.clear()
                        for m in messages:
                            session.conversation_history.append(
                                {
                                    "id": m.get("id") or generate_message_id(),
                                    "role": m.get("role", "user"),
                                    "content": m.get("content", ""),
                                    "attachments": m.get("attachments"),
                                    "timestamp": time.time(),
                                }
                            )
                    else:
                        # Append only the latest user message to server-authoritative history
                        # Identify the latest user message in the request
                        last_user = None
                        for m in reversed(messages):
                            if m.get("role") == "user":
                                last_user = m
                                break
                        if last_user is not None:
                            session.conversation_history.append(
                                {
                                    "id": last_user.get("id") or generate_message_id(),
                                    "role": "user",
                                    "content": last_user.get("content", ""),
                                    "attachments": last_user.get("attachments"),
                                    "timestamp": time.time(),
                                }
                            )

                    # Append assistant response with model metadata
                    try:
                        model_name = getattr(session_config.model, 'model_name', None)
                    except Exception:
                        model_name = None
                    try:
                        engine_name = str(session_config.engine) if getattr(session_config, 'engine', None) else None
                    except Exception:
                        engine_name = None
                    session.conversation_history.append(
                        {
                            "id": generate_message_id(),
                            "role": "assistant",
                            "content": response_content,
                            "timestamp": time.time(),
                            "metadata": {
                                "model_name": model_name,
                                "engine": engine_name,
                                "duration_ms": int(max(0.0, (elapsed if 'elapsed' in locals() else 0.0)) * 1000),
                            },
                        }
                    )

                    # Sync conversation to the active branch: share SAME object for integrity
                    current_branch = session.branch_manager.get_current_branch()
                    current_branch.conversation_history = session.conversation_history
                    # Use datetime for branch timestamps to match ConversationBranch
                    from datetime import datetime as _dt
                    current_branch.last_active = _dt.now()
                    
                    logger.info(
                        f"🔄 Synced conversation to branch '{session.branch_manager.current_branch_id}' - {len(session.conversation_history)} messages"
                    )
                    
                    # Dual-write persistence (best-effort)
                    try:
                        if self.db:
                            self.db.ensure_session(session_id)
                            conv_id = self.db.ensure_conversation(session_id)
                            # Mark session as persistent and record conversation id
                            session.current_conversation_id = conv_id
                            if not getattr(session, 'is_hydrated_from_db', False):
                                session.is_hydrated_from_db = True
                            # Ensure branch exists
                            self.db.ensure_branch(
                                conv_id, 
                                session.branch_manager.current_branch_id, 
                                name=session.branch_manager.current_branch_id
                            )
                            # Append the last two messages (user + assistant) and align IDs with DB ids
                            if len(session.conversation_history) >= 2:
                                last_two = session.conversation_history[-2:]
                                import json as _json
                                assistant_db_id = None
                                for m in last_two:
                                    db_id = self.db.append_message_to_branch(
                                        conv_id,
                                        session.branch_manager.current_branch_id,
                                        role=m.get("role", "user"),
                                        content=str(m.get("content", "")),
                                        created_at=float(m.get("timestamp", time.time())),
                                        metadata=_json.dumps(m.get("metadata", {})) if m.get("metadata") else None,
                                    )
                                    try:
                                        m["id"] = db_id
                                    except Exception:
                                        pass
                                    if m.get("role") == "assistant":
                                        assistant_db_id = db_id
                                # Graph dual-write using message id if message-based schema is present
                                try:
                                    gs_msg = GraphStore(self.db.db_path)
                                    if assistant_db_id:
                                        gs_msg.add_edge_for_message_tail(conv_id, assistant_db_id)
                                except Exception as _gge:
                                    logger.warning(f"[Graph] message-tail dual-write failed: {_gge}")
                            # Update session's current branch record
                            self.db.set_session_current_branch(
                                session_id, 
                                conv_id, 
                                session.branch_manager.current_branch_id
                            )
                            
                            # Graph dual-write
                            try:
                                # Pass exact DB path to GraphStore
                                gs = GraphStore(self.db.db_path)
                                logger.debug(f"[Graph] Using GraphStore at {self.db.db_path}")
                                gs.add_edge_for_branch_tail(
                                    conv_id, session.branch_manager.current_branch_id
                                )
                                logger.debug("[Graph] add_edge_for_branch_tail succeeded")
                            except Exception as ge:
                                logger.warning(f"Graph dual-write failed: {type(ge).__name__}: {ge}")
                                # Extra diagnostics: list graph_edges columns if possible
                                try:
                                    import sqlite3
                                    conn = sqlite3.connect(self.db.db_path)
                                    cur = conn.cursor()
                                    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='graph_edges'")
                                    has_table = bool(cur.fetchone())
                                    if has_table:
                                        cur.execute("PRAGMA table_info('graph_edges')")
                                        cols = [r[1] for r in cur.fetchall()]
                                        logger.warning(f"[Graph] graph_edges columns: {cols}")
                                    else:
                                        logger.warning("[Graph] graph_edges table not found")
                                    conn.close()
                                except Exception as diag_err:
                                    logger.warning(f"[Graph] column inspect failed: {diag_err}")
                    except Exception as pe:
                        logger.warning(f"⚠️ Dual-write persistence failed: {pe}")
                    
                    # Update context usage
                    self.session_manager.update_context_usage(session_id)
                    logger.info(
                        f"🔍 WebChat session updated, conversation length: {len(session.conversation_history)}"
                    )
                    return session
                
                # Use atomic operation for conversation update
                session = await self.session_manager.execute_session_operation(session_id, update_conversation_with_branch)
            
            # Handle streaming vs non-streaming
            if stream:
                # For now, just return non-streaming response
                # TODO: Implement proper streaming with branch support
                logger.warning(f"⚠️ Streaming mode doesn't support branch_id parameter yet, using current branch")
                return web.json_response(response_data)
            else:
                return web.json_response(response_data)
            
        except Exception as e:
            logger.error(f"Error during inference: {str(e)}")
            msg = f"Inference failed: {str(e)}"
            return web.json_response(
                {
                    "message": msg,
                    "error": {
                        "message": msg,
                        "type": "server_error",
                    }
                },
                status=500,
            )
    
    async def handle_enhanced_chat_completions(self, request: web.Request) -> web.Response:
        """Enhanced chat completions with better validation and error handling.
        
        Args:
            request: Web request with chat completion parameters
            
        Returns:
            JSON response with completion result using enhanced format
        """
        if not self.enhanced_features_available or not self.request_validator or not self.response_formatter:
            from oumi.webchat.api_responses import create_json_response
            return create_json_response(
                {"error": "Enhanced features not available"}, 
                status=501
            )
        
        from oumi.webchat.api_responses import create_json_response, ErrorType
        
        try:
            # Validate request
            chat_request = await self.request_validator.validate_chat_request(request)
            
            # Extract required fields
            messages = chat_request.messages
            session_id = chat_request.session_id
            temperature = chat_request.temperature
            max_tokens = chat_request.max_tokens
            stream = chat_request.stream
            
            # Get or create session
            session = await self.session_manager.get_or_create_session_safe(session_id, self.db)
            
            # Convert OpenAI format messages to Oumi conversation format
            oumi_messages = []
            
            # Add system prompt if provided
            if self.system_prompt:
                oumi_messages.append(
                    Message(role=Role.SYSTEM, content=self.system_prompt)
                )
            
            # Convert messages
            for msg in messages:
                role_mapping = {
                    "system": Role.SYSTEM,
                    "user": Role.USER,
                    "assistant": Role.ASSISTANT,
                }
                role = role_mapping.get(msg.get("role"), Role.USER)
                content = msg.get("content", "")
                oumi_messages.append(Message(role=role, content=content))
            
            # Get the latest user message for inference
            user_messages = [msg for msg in messages if msg.get("role") == "user"]
            if not user_messages:
                response_data, status_code = self.response_formatter.error(
                    ErrorType.VALIDATION_ERROR,
                    "No user message found in request"
                )
                return create_json_response(response_data, status_code)
            
            latest_user_raw = user_messages[-1].get("content", "")
            latest_user_content = self._convert_client_content(latest_user_raw)
            latest_user_text = (
                self._content_items_to_text(latest_user_content)
                if isinstance(latest_user_content, list)
                else str(latest_user_content)
            )
            
            # Run inference
            from oumi.infer import infer
            
            results = infer(
                config=session.config,
                inputs=[latest_user_text],
                system_prompt=self.system_prompt,
                inference_engine=session.inference_engine,
            )
            
            if not results:
                response_data, status_code = self.response_formatter.error(
                    ErrorType.INTERNAL_ERROR,
                    "No response generated from inference engine"
                )
                return create_json_response(response_data, status_code)
            
            # Extract response content
            response_content = ""
            conversation = results[0]
            for message in conversation.messages:
                if message.role not in [Role.USER, Role.SYSTEM]:
                    if isinstance(message.content, str):
                        response_content = message.content
                        break
                    elif isinstance(message.content, list):
                        for item in message.content:
                            if hasattr(item, "content") and item.content:
                                response_content = str(item.content)
                                break
            
            if not response_content:
                response_content = str(conversation)
            
            # Format response in OpenAI format
            response_data = {
                "id": f"chatcmpl-{int(time.time())}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": getattr(session.config.model, "model_name", model_name_fallback("session.config.model.model_name")),
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": response_content},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": len(latest_user_text.split()),
                    "completion_tokens": len(response_content.split()),
                    "total_tokens": len(latest_user_text.split()) + len(response_content.split()),
                },
            }
            
            # Update WebChat session
            session.conversation_history.extend([
                {
                    "role": "user",
                    "content": latest_user_text,
                    "timestamp": time.time(),
                },
                {
                    "role": "assistant",
                    "content": response_content,
                    "timestamp": time.time(),
                }
            ])
            
            # Update context usage
            self.session_manager.update_context_usage(session_id)
            
            # Dual-write persistence (best-effort)
            if self.db:
                try:
                    self.db.ensure_session(session_id)
                    conv_id = self.db.ensure_conversation(session_id)
                    # Mark session as persistent and record conversation id
                    session.current_conversation_id = conv_id
                    if not getattr(session, 'is_hydrated_from_db', False):
                        session.is_hydrated_from_db = True
                    # Ensure branch exists
                    self.db.ensure_branch(
                        conv_id, 
                        session.branch_manager.current_branch_id, 
                        name=session.branch_manager.current_branch_id
                    )
                    # Append the last two messages (user + assistant)
                    if len(session.conversation_history) >= 2:
                        last_two = session.conversation_history[-2:]
                        for m in last_two:
                            self.db.append_message_to_branch(
                                conv_id,
                                session.branch_manager.current_branch_id,
                                role=m.get("role", "user"),
                                content=str(m.get("content", "")),
                                created_at=float(m.get("timestamp", time.time())),
                            )
                    # Update session's current branch record
                    self.db.set_session_current_branch(
                        session_id, 
                        conv_id, 
                        session.branch_manager.current_branch_id
                    )
                    
                    # Graph dual-write
                    try:
                        # Pass exact DB path to GraphStore
                        GraphStore(self.db.db_path).add_edge_for_branch_tail(
                            conv_id, session.branch_manager.current_branch_id
                        )
                    except Exception as ge:
                        logger.warning(f"Graph dual-write failed: {ge}")
                except Exception as pe:
                    logger.warning(f"⚠️ Dual-write persistence failed: {pe}")
            
            return create_json_response(response_data)
            
        except Exception as e:
            logger.error(f"Enhanced chat completion error: {e}")
            response_data, status_code = self.response_formatter.internal_error(
                message=f"Chat completion failed: {str(e)}"
            )
            return create_json_response(response_data, status_code)
