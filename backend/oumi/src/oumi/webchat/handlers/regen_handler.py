"""Id-first node regeneration handler for Oumi WebChat."""

from typing import Any, Dict, Optional
import time

from aiohttp import web

from oumi.utils.logging import logger
from oumi.webchat.core.session_manager import SessionManager
from oumi.webchat.protocol import extract_session_id
from oumi.core.types.conversation import Conversation, Message, Role
from oumi.webchat.utils.id_utils import generate_message_id


class RegenHandler:
    def __init__(self, session_manager: SessionManager, db=None):
        self.session_manager = session_manager
        self.db = db

    async def handle_regen_node_api(self, request: web.Request) -> web.Response:
        logger.debug("regen_node: request received")
        try:
            data = await request.json()
        except Exception as e:
            return web.json_response({"error": f"Invalid JSON: {e}"}, status=400)

        # Inputs
        try:
            session_id = extract_session_id(request, data)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)

        branch_id = data.get("branch_id")
        assistant_id = data.get("assistant_id")
        user_message_id = data.get("user_message_id")
        prompt = data.get("prompt")
        history_mode = data.get("history_mode", "last_user")  # last_user | full | none
        is_electron = bool(data.get("electron"))
        logger.debug(
            f"regen_node: inputs session={session_id} branch={branch_id} assistant_id={assistant_id} user_message_id={user_message_id} history_mode={history_mode}"
        )

        # Get session
        session = await self.session_manager.get_or_create_session_safe(session_id, self.db)

        # Optionally switch branch
        async def _maybe_switch(s):
            if branch_id and branch_id != s.branch_manager.current_branch_id:
                try:
                    s.branch_manager.sync_conversation_history(s.conversation_history)
                    ok, msg, br = s.branch_manager.switch_branch(branch_id)
                    if ok and br:
                        s.conversation_history.clear()
                        s.conversation_history.extend(br.conversation_history)
                        logger.debug(f"regen_node: switched to branch {branch_id}")
                except Exception as e:
                    logger.warning(f"regen_node: branch switch failed: {e}")
            return s

        session = await self.session_manager.execute_session_operation(session_id, _maybe_switch)

        # Resolve target and build prompt if needed
        resolved_index: Optional[int] = None  # legacy usage
        target_assistant_index: Optional[int] = None  # atomic: update specific assistant node
        resolved_prompt: Optional[str] = None

        if prompt and isinstance(prompt, str):
            resolved_prompt = prompt
        elif user_message_id:
            for i, m in enumerate(session.conversation_history):
                if m.get("id") == user_message_id and m.get("role") == "user":
                    resolved_index = i
                    resolved_prompt = str(m.get("content", ""))
                    # Prefer to update the assistant that immediately follows this user
                    if i + 1 < len(session.conversation_history) and session.conversation_history[i + 1].get("role") == "assistant":
                        target_assistant_index = i + 1
                    break
        elif assistant_id:
            # Find assistant and its preceding user
            for i, m in enumerate(session.conversation_history):
                if m.get("id") == assistant_id and m.get("role") == "assistant":
                    resolved_index = i
                    target_assistant_index = i
                    # Search backwards for preceding user
                    for j in range(i - 1, -1, -1):
                        if session.conversation_history[j].get("role") == "user":
                            resolved_prompt = str(session.conversation_history[j].get("content", ""))
                            break
                    break

        # Fallback: if assistant/user ids didn't resolve, try the most recent user message
        if not resolved_prompt:
            try:
                for m in reversed(session.conversation_history):
                    if m.get("role") == "user":
                        resolved_prompt = str(m.get("content", ""))
                        logger.debug(
                            "regen_node: assistant/user id not found; falling back to last user message"
                        )
                        break
            except Exception as e:
                logger.debug(f"regen_node: fallback resolution failed: {e}")

        if not resolved_prompt:
            logger.debug("regen_node: failed to resolve prompt; target not found")
            return web.json_response({"error": "Unable to resolve prompt for regeneration: target not found"}, status=400)

        # IMPORTANT: Do NOT truncate conversation history for regeneration.
        # Regeneration should be atomic for the targeted node.

        # Build inference conversation from a visibility slice that excludes the future
        # Visible context: all messages up to the node being regenerated (not beyond)
        if target_assistant_index is not None:
            visible_end = max(0, int(target_assistant_index))  # exclude the assistant itself from input
        elif resolved_index is not None:
            # When targeting via user id, include up to and including that user message
            visible_end = max(0, int(resolved_index) + 1)
        else:
            # Fallback to all messages (no specific target resolved)
            visible_end = len(session.conversation_history)

        visible_history = session.conversation_history[:visible_end]

        convo_msgs = []
        # Optional system prompt
        if hasattr(session, 'system_prompt') and session.system_prompt:
            convo_msgs.append(Message(role=Role.SYSTEM, content=session.system_prompt))

        def _append_from_history(msgs):
            for m in msgs:
                role = m.get("role")
                content = str(m.get("content", ""))
                if not content:
                    continue
                if role == "user":
                    convo_msgs.append(Message(role=Role.USER, content=content))
                elif role == "assistant":
                    convo_msgs.append(Message(role=Role.ASSISTANT, content=content))
                elif role == "system":
                    convo_msgs.append(Message(role=Role.SYSTEM, content=content))

        if history_mode == "full":
            # Include full visible history; if a prompt override is provided, replace the last user content
            if resolved_prompt is not None:
                # Find last user in visible history and override its content
                overridden = False
                for idx in range(len(visible_history) - 1, -1, -1):
                    if visible_history[idx].get("role") == "user":
                        try:
                            visible_history = visible_history.copy()
                            visible_history[idx] = {
                                **visible_history[idx],
                                "content": resolved_prompt,
                            }
                            overridden = True
                        except Exception:
                            pass
                        break
                if not overridden and resolved_prompt:
                    # If no user exists in visible history, add one
                    convo_msgs.append(Message(role=Role.USER, content=resolved_prompt))
            _append_from_history(visible_history)
        elif history_mode == "last_user":
            # Only the most recent user message within the visible context
            last_user_content = None
            for m in reversed(visible_history):
                if m.get("role") == "user":
                    last_user_content = str(m.get("content", ""))
                    break
            if resolved_prompt is not None:
                last_user_content = resolved_prompt
            if last_user_content:
                convo_msgs.append(Message(role=Role.USER, content=last_user_content))
        else:
            # history_mode == "none": only use the provided prompt (if any)
            if resolved_prompt:
                convo_msgs.append(Message(role=Role.USER, content=resolved_prompt))

        full_conversation = Conversation(messages=convo_msgs)
        logger.debug(
            f"regen_node: built visible context with {len(convo_msgs)} messages (visible_end={visible_end}, mode={history_mode})"
        )

        # Choose engine/config respecting /swap
        session_config = session.config
        session_engine = session.inference_engine
        if hasattr(session.command_context, 'config') and session.command_context.config:
            session_config = session.command_context.config
        if hasattr(session.command_context, 'inference_engine') and session.command_context.inference_engine:
            session_engine = session.command_context.inference_engine

        # Inference
        try:
            _t0 = time.time()
            model_response = session_engine.infer(input=[full_conversation], inference_config=session_config)
            _elapsed = max(0.0, time.time() - _t0)
        except Exception as e:
            logger.error(f"regen_node: inference error: {e}")
            return web.json_response({"error": f"Inference failed: {e}"}, status=500)

        response_content = ""
        if model_response:
            last_conv = model_response[-1] if isinstance(model_response, list) else model_response
            for msg in reversed(last_conv.messages):
                if msg.role == Role.ASSISTANT and isinstance(msg.content, str):
                    response_content = msg.content
                    break
        if not response_content:
            response_content = "No response generated"

        # Collect model metadata for UI
        model_name = None
        engine_name = None
        try:
            model_name = getattr(session_config.model, 'model_name', None)
        except Exception:
            pass
        try:
            engine_name = str(getattr(session_config, 'engine', None)) if getattr(session_config, 'engine', None) else None
        except Exception:
            pass
        duration_ms = int((_elapsed if '_elapsed' in locals() else 0.0) * 1000)
        try:
            # We logged elapsed earlier around inference; recompute lightweight if needed
            # Not tracking start separately here; omit if unavailable
            pass
        except Exception:
            pass

        # Update targeted assistant message in-place; do not mutate other nodes
        updated_id: Optional[str] = None
        if target_assistant_index is not None and 0 <= target_assistant_index < len(session.conversation_history):
            try:
                target_msg = session.conversation_history[target_assistant_index]
                target_msg["content"] = response_content
                target_msg["timestamp"] = time.time()
                # Update metadata if present
                try:
                    md = target_msg.get("metadata") or {}
                    if model_name:
                        md["model_name"] = model_name
                    if engine_name:
                        md["engine"] = engine_name
                    if duration_ms is not None:
                        md["duration_ms"] = duration_ms
                    target_msg["metadata"] = md
                except Exception:
                    pass
                updated_id = target_msg.get("id")
                logger.debug(f"regen_node: updated assistant at index {target_assistant_index} (id={updated_id})")
            except Exception:
                # If update fails unexpectedly, return an error rather than appending
                return web.json_response({"error": "Failed to update target node"}, status=500)

        if updated_id is None:
            # Strict atomic behavior: don't append; require a resolvable target node
            logger.debug("regen_node: target assistant node not found; aborting")
            return web.json_response({"error": "Target assistant node not found or not resolvable"}, status=400)

        # Sync branch snapshot
        try:
            current_branch = session.branch_manager.get_current_branch()
            current_branch.conversation_history = session.conversation_history.copy()
            current_branch.last_active = time.time()
        except Exception as e:
            logger.debug(f"regen_node: branch sync failed: {e}")

        # Persist update (best-effort)
        new_id = updated_id
        if self.db:
            try:
                self.db.ensure_session(session_id)
                conv_id = self.db.ensure_conversation(session_id)
                session.current_conversation_id = conv_id
                if not getattr(session, 'is_hydrated_from_db', False):
                    session.is_hydrated_from_db = True
                self.db.ensure_branch(conv_id, session.branch_manager.current_branch_id, name=session.branch_manager.current_branch_id)
                if target_assistant_index is not None:
                    # Update existing assistant message at the target sequence
                    db_updated_id = self.db.update_branch_message(
                        conv_id,
                        session.branch_manager.current_branch_id,
                        seq=target_assistant_index,
                        role="assistant",
                        content=response_content,
                        created_at=float(time.time()),
                        metadata=None,
                    )
                    if db_updated_id:
                        new_id = db_updated_id
                        # Ensure in-memory id reflects DB id if changed (typically same)
                        try:
                            session.conversation_history[target_assistant_index]["id"] = db_updated_id
                        except Exception:
                            pass
                    logger.debug(f"regen_node: DB update completed for seq={target_assistant_index} id={new_id}")
                else:
                    # No specific target in history: append a new assistant message to DB
                    db_id = self.db.append_message_to_branch(
                        conv_id,
                        session.branch_manager.current_branch_id,
                        role="assistant",
                        content=response_content,
                        created_at=float(time.time()),
                        force_new=is_electron,
                    )
                    # Align the last in-memory message id if it was appended above
                    try:
                        session.conversation_history[-1]["id"] = db_id
                    except Exception:
                        pass
                    new_id = db_id
                self.db.set_session_current_branch(session_id, conv_id, session.branch_manager.current_branch_id)
            except Exception as pe:
                logger.warning(f"regen_node: persistence failed: {pe}")

        # Broadcast a minimal message update only (do not broadcast full conversation)
        try:
            await session.broadcast_to_websockets(
                {
                    "type": "message_update",
                    "message": {
                        "id": new_id,
                        "role": "assistant",
                        "content": response_content,
                        "timestamp": time.time(),
                    },
                    "target": {
                        "assistant_id": assistant_id,
                        "user_message_id": user_message_id,
                        "resolved_index": resolved_index,
                        "target_assistant_index": target_assistant_index,
                    },
                    "current_branch": session.branch_manager.current_branch_id,
                }
            )
        except Exception:
            pass

        logger.debug("regen_node: returning success response")
        return web.json_response(
            {
                "success": True,
                "assistant": {"id": new_id, "content": response_content, "metadata": {"model_name": model_name, "engine": engine_name, "duration_ms": duration_ms}},
                "target": {
                    "assistant_id": assistant_id,
                    "user_message_id": user_message_id,
                    "resolved_index": resolved_index,
                    "target_assistant_index": target_assistant_index,
                    "visible_end": visible_end,
                },
                "broadcast": True,
            }
        )
